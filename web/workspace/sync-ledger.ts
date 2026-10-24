// Each local op's sync state (task #14, plan-task14-is-op-confirmed r6 and its delta 1): a durable ledger, one row
// per local op the scan passed, owned by the record that carries it; and the two questions asked of it, syncState
// (where are these ops?) and waitSync (wake me when they have got there).
//
// - The store `syncLedger`, keyed [ns, lseq], row {s, d, dseq?, code?, reason?, by?}: `s` local, accepted,
//   confirmed, refused, superseded or none; `d` 1 once decided (confirmed, refused, superseded, none).  Written in
//   the transactions that already exist: the scan page (a row for each local op it passes), a successor's
//   allocation, acked, confirmed, the rebuild's retire, and the seeding pass after the upgrade.
// - A row has one owner, the dseq stored in it, and a record writes only the row it owns: a direct record its own
//   lseq, a successor the held write it carries (`heldSeq`), never its bookkeeping lseq; journal records (lseq 0)
//   own none (CORR-T14-1).
// - Decided rows are capped at LEDGER.decided per namespace, exactly: a transaction that decides k rows prunes, in
//   itself, the oldest decided rows other than its own past the cap (byDecided), and raises `ledgerFloor` to the
//   highest it pruned.  A seq with no row at or below the floor is `expired`: an honest answer, never a guess.
// - Events (this page's hub, and a BroadcastChannel to the others) are hints: a wait reads the durable rows once at
//   registration and again after a hint that it missed something (a rev gap, a new holder, a lock change); what the
//   rows say then is the answer.
// - `sent` is never durable: the sender's in-flight seqs, fenced by the lease generation (each connection a new one).
// - A wait lives for its (namespace, epoch): reconnects and takeovers keep it (only `sent` falls back to `local`);
//   off, sign-out, delete or another account end it, as none/sync-off or none/switched.
import type { Op, Workspace } from "./api";
import { WorkspaceError } from "./api";
import { req } from "./db";

export const LEDGER = {
  /** decided rows kept at most per namespace (the oldest pruned past it, in the deciding transaction) */
  decided: 50_000,
  /** rebuild watermark jumps remembered per namespace (delta 1, D1); past it, the oldest's range expires */
  skips: 16,
  /** records read, and rows written, per seeding transaction */
  seedPage: 1000,
};
export const WAIT = {
  /** seqs in one wait */
  seqs: 10_000,
  /** waits at once per Workspace */
  max: 16,
  /** the largest timeoutMs (the platform timer's range) */
  timeoutMax: 2 ** 31 - 1,
  /** seqs read per snapshot transaction */
  page: 1000,
};
/** seqs in one syncState call */
export const STATE = { max: 1000 };
export const OBSOLETE = {
  /** namespaces whose ledgers wait to be deleted, at most (a switch waits for room) */
  max: 2,
  /** rows deleted per cleanup transaction, and the pause between them */
  page: 1000,
  gapMs: 1000,
};

export type RowState = "local" | "accepted" | "confirmed" | "refused" | "superseded" | "none";
export type Row = { ns: string; lseq: number; s: RowState; d: 0 | 1; dseq?: number; code?: string; reason?: string; by?: number };
export type SyncLevel = "local" | "sent" | "accepted" | "confirmed";
export type SyncName = SyncLevel | "refused" | "superseded" | "none";
export type SyncAnswer = { seq: number; sync: SyncName; reason?: string; code?: string };
export type Counts = Record<SyncName, number>;
export type WaitResult = { sync: SyncName; counts: Counts };

const k = (ns: string, what: string) => `sync:${ns}:${what}`;
export const ledgerKeys = (ns: string) => ({
  count: k(ns, "ledgerCount"), floor: k(ns, "ledgerFloor"), from: k(ns, "ledgerFrom"), seeded: k(ns, "ledgerSeeded"),
  skips: k(ns, "ledgerSkips"), rev: k(ns, "ledgerRev"), wipe: k(ns, "ledgerWipe"), seedAt: k(ns, "ledgerSeedAt"),
});
export const OBSOLETE_KEY = "sync:obsolete";
// (a rebuild's watermark jump, as kept: [from, to, reasonCode], at most LEDGER.skips of them (delta 1 r2))
type Skip = [number, number, number];
const SKIP_REASONS = ["invalid", "diverged", "refused"];
/** The skips as kept, validated: anything not of that shape is read as none (the floor kept). */
function skipsOf(v: unknown): Skip[] {
  if (!Array.isArray(v) || v.length > LEDGER.skips) return [];
  for (const t of v) if (!Array.isArray(t) || t.length !== 3 || !Number.isSafeInteger(t[0]) || !Number.isSafeInteger(t[1]) || !(t[2] === 0 || t[2] === 1 || t[2] === 2)) return [];
  return v as Skip[];
}
/** Whether a local op goes up as a record of its own: what wireOf (sync-outbox.ts) sends (it asks this). */
export const isWire = (o: Op) => o.origin !== "server" && "after" in o && o.after !== undefined && o.op !== "dropVersions";

// ---- the hub: this page's listeners, and the other tabs through a BroadcastChannel

export type Msg =
  | { t: "rows"; ns: string; epoch: number; rev: number; items: [number, RowState, string?, string?][] }
  | { t: "sent"; ns: string; epoch: number; gen: number; seqs: number[] }
  | { t: "reset"; ns: string; epoch: number; gen: number }
  | { t: "holder"; ns: string; epoch: number; gen: number; rev: number }
  | { t: "seeded"; ns: string; epoch: number; rev: number }
  | { t: "lifecycle"; ns: string; fromEpoch: number; toEpoch: number; kind: "off" | "switch" }
  | { t: "hello"; ns: string; epoch: number; nonce: string }
  | { t: "inflight"; ns: string; epoch: number; gen: number; nonce: string; seqs: number[] };

export class Hub {
  private subs = new Set<(m: Msg) => void>();
  private ch: BroadcastChannel | null = null;
  /** this page's sender's in-flight seqs (the rows each record in flight owns), if this page is the sender */
  inflight: { ns: string; epoch: number; gen: number; seqs: Set<number> } | null = null;
  constructor(name: string) {
    if (typeof BroadcastChannel === "function") {
      this.ch = new BroadcastChannel("sagebrush-sync-progress:" + name);
      this.ch.onmessage = (ev) => this.deliver(ev.data as Msg);
    }
  }
  on(f: (m: Msg) => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
  get listeners() { return this.subs.size; }
  post(m: Msg) {
    this.deliver(m);
    try { this.ch?.postMessage(m); } catch {}
  }
  private deliver(m: Msg) {
    if (!m || typeof m !== "object") return;
    // (a hello is answered by the page that sends: its in-flight seqs, under its generation)
    if (m.t === "hello" && this.inflight && this.inflight.ns === m.ns && this.inflight.epoch === m.epoch) {
      const f = this.inflight;
      queueMicrotask(() => this.post({ t: "inflight", ns: f.ns, epoch: f.epoch, gen: f.gen, nonce: m.nonce, seqs: [...f.seqs] }));
    }
    for (const f of this.subs) try { f(m); } catch (e) { console.warn("sync ledger:", e); }
  }
  // (the sender's side)
  sent(ns: string, epoch: number, gen: number, seqs: number[]) {
    if (!this.inflight || this.inflight.ns !== ns || this.inflight.gen !== gen) this.inflight = { ns, epoch, gen, seqs: new Set() };
    for (const s of seqs) this.inflight.seqs.add(s);
    if (seqs.length) this.post({ t: "sent", ns, epoch, gen, seqs });
  }
  answered(ns: string, gen: number, seqs: number[]) {
    if (this.inflight?.ns === ns && this.inflight.gen === gen) for (const s of seqs) this.inflight.seqs.delete(s);
  }
  reset(ns: string, epoch: number, gen: number) {
    if (this.inflight?.ns === ns && this.inflight.gen === gen) this.inflight = null;
    this.post({ t: "reset", ns, epoch, gen });
  }
}
const hubs = new WeakMap<IDBDatabase, Hub>();
export function hubOf(db: IDBDatabase): Hub {
  let h = hubs.get(db);
  if (!h) hubs.set(db, (h = new Hub(db.name)));
  return h;
}

// ---- writing rows, in the transactions that already exist

const isTerminalRow = (r: Row) => r.d === 1;
const metaGet = async <T>(meta: IDBObjectStore, key: string) => (await req(meta.get(key))) as T | undefined;

/** The ledger's part of one transaction (it takes `syncLedger` and `meta`): rows written as the transaction goes,
 * then finish() once at its end: the decided count and the cap, the revision, and the event after it commits. */
export class LedgerTx {
  private items: [number, RowState, string?, string?][] = [];
  private decidedHere = new Set<number>();
  private rows: IDBObjectStore;
  private meta: IDBObjectStore;
  constructor(readonly tx: IDBTransaction, readonly ns: string) {
    this.rows = tx.objectStore("syncLedger");
    this.meta = tx.objectStore("meta");
  }
  private write(row: Row, was?: Row) {
    this.rows.put(row);
    if (row.d === 1 && !(was && was.d === 1)) this.decidedHere.add(row.lseq);
    this.items.push(row.reason !== undefined || row.code !== undefined ? [row.lseq, row.s, row.reason, row.code] : [row.lseq, row.s]);
  }
  private get = async (lseq: number) => (await req(this.rows.get([this.ns, lseq]))) as Row | undefined;

  /** A scanned op's row: undecided (`local`, owned by `dseq` if a record carries it) or decided at once (`none`,
   * `superseded`).  A row already decided is left as it is (a resumed seed, a wipe's leftovers: never lowered). */
  async scanned(lseq: number, s: "local" | "none" | "superseded", more: { dseq?: number; reason?: string; by?: number } = {}) {
    const was = await this.get(lseq);
    if (was && isTerminalRow(was)) return;
    this.write({ ns: this.ns, lseq, s, d: s === "local" ? 0 : 1, ...(more.dseq !== undefined ? { dseq: more.dseq } : {}), ...(more.reason ? { reason: more.reason } : {}), ...(more.by !== undefined ? { by: more.by } : {}) }, was);
  }
  /** A held write's row given to the successor record that now carries it (still `local`). */
  async own(lseq: number, dseq: number) {
    const was = await this.get(lseq);
    if (!was || isTerminalRow(was)) return;
    this.write({ ...was, dseq }, was);
  }
  /** The decision of the record `dseq` for the row it owns: written only if the row is that record's, undecided,
   * and the decision moves it on (accepted only from local). */
  async decide(lseq: number, dseq: number, s: "accepted" | "confirmed" | "refused" | "superseded", more: { code?: string; reason?: string } = {}) {
    const was = await this.get(lseq);
    if (!was || was.dseq !== dseq || isTerminalRow(was)) return;
    if (s === "accepted" && was.s !== "local") return;
    const { code: _c, reason: _r, ...base } = was;
    this.write({ ...base, s, d: s === "accepted" ? 0 : 1, ...(more.code !== undefined ? { code: more.code } : {}), ...(more.reason !== undefined ? { reason: more.reason } : {}) }, was);
  }
  /** An undecided row superseded whoever owns it (a later held write, its identity gone, a rebuild). */
  async supersede(lseq: number, reason: string, by?: number) {
    const was = await this.get(lseq);
    if (!was || isTerminalRow(was)) return;
    const { code: _c, ...base } = was;
    this.write({ ...base, s: "superseded", d: 1, reason, ...(by !== undefined ? { by } : {}) }, was);
  }
  /** The end of the transaction's ledger work: the decided count raised by what it decided, and, past the cap, the
   * oldest decided rows not decided here pruned in it and the floor raised; the revision moved on; the event posted
   * once the transaction commits.  Nothing written: nothing done. */
  async finish() {
    if (!this.items.length) return;
    const keys = ledgerKeys(this.ns), meta = this.meta;
    let count = ((await metaGet<number>(meta, keys.count)) ?? 0) + this.decidedHere.size;
    let floor = (await metaGet<number>(meta, keys.floor)) ?? 0;
    if (count > LEDGER.decided) {
      const r = await pruneOldest(this.rows, this.ns, count - LEDGER.decided, this.decidedHere);
      count -= r.pruned;
      floor = Math.max(floor, r.highest);
      meta.put(floor, keys.floor);
    }
    meta.put(count, keys.count);
    const rev = ((await metaGet<number>(meta, keys.rev)) ?? 0) + 1;
    meta.put(rev, keys.rev);
    const epoch = (await metaGet<number>(meta, "sync:epoch")) ?? 0;
    const db = this.tx.db, msg: Msg = { t: "rows", ns: this.ns, epoch, rev, items: this.items };
    this.tx.addEventListener("complete", () => hubOf(db).post(msg));
  }
}

/** The oldest `n` decided rows of `ns`, by lseq, other than `keep`, deleted through byDecided: one cursor, at most
 * n + keep.size steps. */
function pruneOldest(rows: IDBObjectStore, ns: string, n: number, keep: Set<number>): Promise<{ pruned: number; highest: number }> {
  return new Promise((ok, no) => {
    let pruned = 0, highest = 0;
    const c = rows.index("byDecided").openCursor(IDBKeyRange.bound([ns, 1, -Infinity], [ns, 1, Infinity]));
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur || pruned >= n) return ok({ pruned, highest });
      const lseq = (cur.value as Row).lseq;
      if (!keep.has(lseq)) {
        cur.delete();
        pruned++;
        highest = Math.max(highest, lseq);
      }
      cur.continue();
    };
    c.onerror = () => no(c.error);
  });
}

/** A rebuild's watermark jump (delta 1, D1): local ops in (from, to] went up through its reissue journal, not as
 * records of their own; a seq there with no row answers superseded/<reason>.  At most LEDGER.skips kept: past it,
 * the oldest goes and the floor rises over its range (its seqs then honestly `expired`).  In `meta`'s transaction. */
export async function noteSkip(meta: IDBObjectStore, ns: string, from: number, to: number, reason: string) {
  if (!(to > from)) return;
  const keys = ledgerKeys(ns);
  const code = Math.max(0, SKIP_REASONS.indexOf(reason));
  const list = skipsOf(await metaGet(meta, keys.skips)).concat([[from, to, code]]);
  while (list.length > LEDGER.skips) {
    const old = list.shift()!;
    meta.put(Math.max((await metaGet<number>(meta, keys.floor)) ?? 0, old[1]), keys.floor);
  }
  meta.put(list, keys.skips);
}

// ---- reading: one page's view, and a seq's class

export type View = { ns: string; epoch: number; off: boolean; seeded: boolean; floor: number; from: number; scanned: number; skips: Skip[]; rev: number };
async function viewOf(meta: IDBObjectStore, ns?: string): Promise<View | null> {
  const cur = await metaGet<{ ns: string; gen: number; off?: boolean }>(meta, "sync:current");
  const epoch = (await metaGet<number>(meta, "sync:epoch")) ?? 0;
  const n = ns ?? cur?.ns;
  if (!n) return null;
  const keys = ledgerKeys(n);
  return {
    ns: n, epoch, off: !cur || !!cur.off || cur.ns !== n,
    seeded: (await metaGet(meta, keys.seeded)) !== undefined,
    floor: (await metaGet<number>(meta, keys.floor)) ?? 0,
    from: (await metaGet<number>(meta, keys.from)) ?? 0,
    scanned: (await metaGet<number>(meta, k(n, "scanned"))) ?? 0,
    skips: skipsOf(await metaGet(meta, keys.skips)),
    rev: (await metaGet<number>(meta, keys.rev)) ?? 0,
  };
}
/** What a seq with no row is (r6 §3.2, delta 1 r2): the floor first; then a retained skip, only for an op still in
 * the log and proven a local wire op; then the seed's boundary; then by its op's origin past the watermark. */
export function classOf(seq: number, v: View, op: Op | undefined): { s: RowState; reason?: string } {
  if (seq <= v.floor) return { s: "none", reason: "expired" };
  for (const [from, to, code] of v.skips) if (seq > from && seq <= to) {
    if (!op) return { s: "none", reason: "expired" };
    if (op.origin === "server") return { s: "none", reason: "not-local" };
    if (!isWire(op)) return { s: "none", reason: "not-synced" };
    return { s: "superseded", reason: SKIP_REASONS[code] };
  }
  if (seq <= v.from) return { s: "none", reason: "before-ledger" };
  if (seq > v.scanned) return op && op.origin !== "server" ? { s: "local" } : { s: "none", reason: "not-local" };
  return { s: "none", reason: "not-local" };
}
/** Whether classOf needs `seq`'s op: past the watermark, or inside a skip (and above the floor). */
const needsOp = (seq: number, v: View) => seq > v.floor && (seq > v.scanned || v.skips.some(([from, to]) => seq > from && seq <= to));

// ---- syncState

function checkSeqs(seqs: unknown, max: number): number[] {
  if (!Array.isArray(seqs) || seqs.length === 0) throw new WorkspaceError("invalid", "seqs is a non-empty list of op seqs");
  if (seqs.length > max) throw Object.assign(new WorkspaceError("limit", `at most ${max} seqs at once`), { max });
  const seen = new Set<number>();
  for (const s of seqs) {
    if (!Number.isSafeInteger(s) || (s as number) < 1 || seen.has(s as number)) throw new WorkspaceError("invalid", "seqs are distinct positive safe integers");
    seen.add(s as number);
  }
  return seqs as number[];
}

/** Where each of `seqs` (at most STATE.max) is, in one transaction: none/sync-off with sync off; busy ("seeding")
 * until the namespace's ledger is seeded after the upgrade; `sent` only as this page's own sender knows it. */
export async function syncState(w: Workspace, seqs: number[]): Promise<SyncAnswer[]> {
  const list = checkSeqs(seqs, STATE.max);
  const tx = w.ws.transaction(["syncLedger", "meta", "ops"], "readonly");
  const v = await viewOf(tx.objectStore("meta"));
  if (!v || v.off) return list.map((seq) => ({ seq, sync: "none", reason: "sync-off" }));
  if (!v.seeded) throw Object.assign(new WorkspaceError("busy", "sync is preparing its ledger: ask again shortly"), { reason: "seeding" });
  const rows = tx.objectStore("syncLedger"), ops = tx.objectStore("ops");
  const fl = hubOf(w.ws).inflight;
  const out: SyncAnswer[] = [];
  for (const seq of list) {
    const row = (await req(rows.get([v.ns, seq]))) as Row | undefined;
    const c = row ?? classOf(seq, v, needsOp(seq, v) ? ((await req(ops.get(seq))) as Op | undefined) : undefined);
    const sent = c.s === "local" && fl?.ns === v.ns && fl.epoch === v.epoch && fl.seqs.has(seq);
    out.push({ seq, sync: sent ? "sent" : c.s, ...(c.reason ? { reason: c.reason } : {}), ...(row?.code ? { code: row.code } : {}) });
  }
  return out;
}

// ---- waitSync

// (a slot's code: 0 nothing observed yet; 1 local, 2 accepted, 3 confirmed; then the terminal ones; SENT, a bit on
// a local (or unobserved) slot)
const LOCAL = 1, ACCEPTED = 2, CONFIRMED = 3, REFUSED = 4, SUPERSEDED = 5, SUPERSEDED_LOCAL = 6, NONE = 7, SENT = 0x80;
const codeOf = (s: RowState, reason?: string) => s === "local" ? LOCAL : s === "accepted" ? ACCEPTED : s === "confirmed" ? CONFIRMED : s === "refused" ? REFUSED : s === "superseded" ? (reason === "local" ? SUPERSEDED_LOCAL : SUPERSEDED) : NONE;
const LEVEL: Record<SyncLevel, number> = { local: 1, sent: 2, accepted: 3, confirmed: 4 };
// (progress order: unobserved and local below sent below accepted below confirmed)
const progressOf = (c: number) => { const b = c & 0x7f; return b === CONFIRMED ? 4 : b === ACCEPTED ? 3 : c & SENT ? 2 : b === LOCAL ? 1 : 0; };
const terminal = (c: number) => (c & 0x7f) >= REFUSED;
// (the counts' bucket of a code: what the result calls it)
function bucketOf(c: number): number {
  const b = c & 0x7f;
  if (b >= REFUSED) return b;
  if (b === CONFIRMED || b === ACCEPTED) return b;
  return c & SENT ? 8 : LOCAL;
}
// (the worst first: refused, superseded by a rebuild, then the least progress, then a local supersession, none)
const RANK = [REFUSED, SUPERSEDED, LOCAL, 8, ACCEPTED, CONFIRMED, SUPERSEDED_LOCAL, NONE];
const NAME: Record<number, SyncName> = { [LOCAL]: "local", 8: "sent", [ACCEPTED]: "accepted", [CONFIRMED]: "confirmed", [REFUSED]: "refused", [SUPERSEDED]: "superseded", [SUPERSEDED_LOCAL]: "superseded", [NONE]: "none" };
/** Two codes merged: a terminal one absorbs; otherwise progress only rises (the sent bit kept on a local slot). */
function merge(cur: number, next: number): number {
  if (terminal(cur)) return cur;
  if (terminal(next)) return next;
  const b = Math.max(cur & 0x7f, next & 0x7f);
  return b <= LOCAL ? b | ((cur | next) & SENT) : b;
}

type Waiter = {
  ns: string; epoch: number; level: number;
  seqs: Float64Array; st: Uint8Array; counts: Int32Array;
  maxGen: number; lastRev: number; nonce: string;
  reading: boolean; again: boolean; ready: boolean; done: boolean;
  settle: (how: "resolve" | "reject", e?: unknown) => void;
};
const waiters = new WeakMap<object, Set<Waiter>>();
/** (tests) the waits registered on `w`, now */
export const waitCount = (w: Workspace) => waiters.get(w)?.size ?? 0;

function find(x: Waiter, seq: number): number {
  let lo = 0, hi = x.seqs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, v = x.seqs[mid];
    if (v === seq) return mid;
    if (v < seq) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
function setSlot(x: Waiter, i: number, code: number) {
  const was = x.st[i], now = merge(was, code);
  if (now === was) return;
  if (was) x.counts[bucketOf(was)]--;
  x.st[i] = now;
  x.counts[bucketOf(now)]++;
}
function clearSent(x: Waiter) {
  for (let i = 0; i < x.st.length; i++) if (x.st[i] & SENT) {
    x.counts[bucketOf(x.st[i])]--;
    x.st[i] &= 0x7f;
    if (x.st[i]) x.counts[bucketOf(x.st[i])]++;
  }
}
function result(x: Waiter): WaitResult {
  const c = x.counts, unobserved = x.st.length - c.reduce((a, b) => a + b, 0);
  const counts: Counts = { local: c[LOCAL] + unobserved, sent: c[8], accepted: c[ACCEPTED], confirmed: c[CONFIRMED], refused: c[REFUSED], superseded: c[SUPERSEDED] + c[SUPERSEDED_LOCAL], none: c[NONE] };
  let sync: SyncName = "none";
  for (const b of RANK) if ((b === LOCAL ? c[LOCAL] + unobserved : c[b]) > 0) { sync = NAME[b]; break; }
  return { sync, counts };
}
function satisfied(x: Waiter): boolean {
  if (!x.ready) return false;
  for (let i = 0; i < x.st.length; i++) {
    const c = x.st[i];
    if (!terminal(c) && progressOf(c) < x.level) return false;
  }
  return true;
}
function endEpoch(x: Waiter, reason: "sync-off" | "switched") {
  for (let i = 0; i < x.st.length; i++) if (!terminal(x.st[i]) && progressOf(x.st[i]) < LEVEL.confirmed) {
    if (x.st[i]) x.counts[bucketOf(x.st[i])]--;
    x.st[i] = NONE;
    x.counts[NONE]++;
  }
  void reason;
  x.ready = true;
  x.settle("resolve");
}

/** Wait until every one of `seqs` (the ops a call collected: at most WAIT.seqs) has reached `level` or a final state;
 * resolves {sync, counts}.  `signal` is required; `timeoutMs` is optional, with no default.  Refusals are immediate
 * and typed: `limit` (too many seqs, {max}), `busy` (WAIT.max waits already), `invalid`. */
export async function waitSync(w: Workspace, seqs: number[], opts: { level?: SyncLevel; signal: AbortSignal; timeoutMs?: number }): Promise<WaitResult> {
  const list = checkSeqs(seqs, WAIT.seqs);
  const level = opts?.level ?? "accepted";
  if (!(level in LEVEL)) throw new WorkspaceError("invalid", "level is local, sent, accepted or confirmed");
  const signal = opts?.signal;
  if (!signal || typeof (signal as AbortSignal).aborted !== "boolean" || typeof signal.addEventListener !== "function") throw new WorkspaceError("invalid", "waitSync needs an AbortSignal");
  const t = opts.timeoutMs;
  if (t !== undefined && (!Number.isSafeInteger(t) || t < 1 || t > WAIT.timeoutMax)) throw Object.assign(new WorkspaceError("invalid", `timeoutMs is an integer from 1 to ${WAIT.timeoutMax}`), { max: WAIT.timeoutMax });
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
  let set = waiters.get(w);
  if (!set) waiters.set(w, (set = new Set()));
  if (set.size >= WAIT.max) throw Object.assign(new WorkspaceError("busy", `at most ${WAIT.max} waits at once`), { max: WAIT.max });

  // (the lifecycle it is bound to: sync off, the answer at once)
  const v0 = await new Promise<View | null>((ok, no) => {
    const tx = w.ws.transaction("meta", "readonly");
    viewOf(tx.objectStore("meta")).then(ok, no);
  });
  if (!v0 || v0.off) {
    const counts: Counts = { local: 0, sent: 0, accepted: 0, confirmed: 0, refused: 0, superseded: 0, none: list.length };
    return { sync: "none", counts };
  }
  if (set.size >= WAIT.max) throw Object.assign(new WorkspaceError("busy", `at most ${WAIT.max} waits at once`), { max: WAIT.max });
  const sorted = Float64Array.from(list).sort();
  const hub = hubOf(w.ws);
  return new Promise<WaitResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null, unsub: (() => void) | null = null;
    const onAbort = () => x.settle("reject", signal.reason ?? new DOMException("aborted", "AbortError"));
    const x: Waiter = {
      ns: v0.ns, epoch: v0.epoch, level: LEVEL[level],
      seqs: sorted, st: new Uint8Array(sorted.length), counts: new Int32Array(9),
      maxGen: 0, lastRev: v0.rev, nonce: Math.random().toString(36).slice(2), reading: false, again: false, ready: false, done: false,
      settle: (how, e) => {
        if (x.done) return;
        x.done = true;
        // (every exit releases all it holds: the slot, the listener, the abort listener, the timer)
        set!.delete(x);
        unsub?.();
        signal.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        const r = result(x);
        if (how === "resolve") resolve(r);
        else reject(Object.assign(e instanceof Error ? e : new WorkspaceError("busy", String(e)), { counts: r.counts, sync: r.sync }));
      },
    };
    set!.add(x);
    signal.addEventListener("abort", onAbort, { once: true });
    if (t !== undefined) timer = setTimeout(() => x.settle("reject", Object.assign(new WorkspaceError("busy", "timed out"), { timeout: true })), t);
    // (subscribed before anything is read: nothing committed after the read can be missed)
    unsub = hub.on((m) => onMsg(x, m, () => reread(w, x)));
    void reread(w, x);
    hub.post({ t: "hello", ns: x.ns, epoch: x.epoch, nonce: x.nonce });
  });
}

function onMsg(x: Waiter, m: Msg, again: () => void) {
  if (x.done || m.ns !== x.ns) return;
  // (the lifecycle first, by type: the epoch it ends is the wait's)
  if (m.t === "lifecycle") {
    if (m.fromEpoch === x.epoch) endEpoch(x, m.kind === "switch" ? "switched" : "sync-off");
    return;
  }
  if (m.epoch !== x.epoch) return;
  switch (m.t) {
    case "rows": {
      if (m.rev > x.lastRev + 1) again();
      x.lastRev = Math.max(x.lastRev, m.rev);
      for (const [seq, s, reason] of m.items) {
        const i = find(x, seq);
        if (i >= 0) setSlot(x, i, codeOf(s, reason));
      }
      break;
    }
    case "sent":
    case "inflight": {
      if (m.t === "inflight" && m.nonce !== x.nonce) return;
      if (m.gen < x.maxGen) return;
      if (m.gen > x.maxGen) {
        x.maxGen = m.gen;
        clearSent(x);
      }
      for (const seq of m.seqs) {
        const i = find(x, seq);
        if (i >= 0 && progressOf(x.st[i]) <= 1 && !terminal(x.st[i])) setSlot(x, i, (x.st[i] || LOCAL) | SENT);
      }
      break;
    }
    case "reset":
      if (m.gen < x.maxGen) return;
      x.maxGen = m.gen;
      clearSent(x);
      break;
    case "holder":
      if (m.gen > x.maxGen) {
        x.maxGen = m.gen;
        clearSent(x);
      }
      if (m.rev > x.lastRev) again();
      break;
    case "seeded":
      again();
      break;
  }
  if (satisfied(x)) x.settle("resolve");
}

/** The wait's slots not yet final read from the durable rows (pages of WAIT.page seqs, each one transaction), and
 * classified: the snapshot is the baseline (r6 §3.2).  One at a time per wait; asked again while running, once more. */
async function reread(w: Workspace, x: Waiter) {
  if (x.reading) {
    x.again = true;
    return;
  }
  x.reading = true;
  try {
    do {
      x.again = false;
      let seeded = true;
      for (let at = 0; at < x.seqs.length && !x.done; ) {
        const idx: number[] = [];
        for (; at < x.seqs.length && idx.length < WAIT.page; at++) if (!terminal(x.st[at]) && progressOf(x.st[at]) < LEVEL.confirmed) idx.push(at);
        if (!idx.length) continue;
        const page = await readPage(w, x, idx);
        if (x.done) return;
        if (page === "ended") return;
        if (page === "unseeded") { seeded = false; continue; }
        for (const [i, code] of page) setSlot(x, i, code);
      }
      if (seeded) x.ready = true;
    } while (x.again && !x.done);
  } catch (e) {
    x.settle("reject", e);
    return;
  } finally {
    x.reading = false;
  }
  if (!x.done && satisfied(x)) x.settle("resolve");
}
async function readPage(w: Workspace, x: Waiter, idx: number[]): Promise<[number, number][] | "ended" | "unseeded"> {
  const tx = w.ws.transaction(["syncLedger", "meta", "ops"], "readonly");
  const v = await viewOf(tx.objectStore("meta"), x.ns);
  // (the lifecycle checked in the same transaction as the rows: moved on, the wait ends as it would on the message)
  const cur = (await req(tx.objectStore("meta").get("sync:current"))) as { ns: string; off?: boolean } | undefined;
  if (!v || v.epoch !== x.epoch || !cur || cur.ns !== x.ns || cur.off) {
    endEpoch(x, cur && cur.ns !== x.ns && !cur.off ? "switched" : "sync-off");
    return "ended";
  }
  const rows = tx.objectStore("syncLedger"), ops = tx.objectStore("ops");
  const out: [number, number][] = [];
  for (const i of idx) {
    const seq = x.seqs[i];
    const row = (await req(rows.get([x.ns, seq]))) as Row | undefined;
    if (row) { out.push([i, codeOf(row.s, row.reason)]); continue; }
    // (before the seed, a missing row says nothing: the slot stays as it is, read again once seeded)
    if (!v.seeded) continue;
    const c = classOf(seq, v, needsOp(seq, v) ? ((await req(ops.get(seq))) as Op | undefined) : undefined);
    out.push([i, codeOf(c.s, c.reason)]);
  }
  return v.seeded ? out : out.length ? out : "unseeded";
}

// ---- seeding, after the upgrade (CORR-T14-5) and when a namespace becomes current again

// (the fields an echo must repeat of its record (sync-client.ts SAME), but `base`, which the scan sets itself from
// the identity's state rather than the op's: delta 1, D3)
const OWN = ["dseq", "t", "by", "op", "path", "to", "kind", "ref", "fid", "sha256", "size", "parent"] as const;
type Rec = { ns: string; dseq: number; lseq: number; op: Record<string, unknown>; accepted?: number; heldSeq?: number };

/** The namespace's ledger made ready, under the sender lock, before any scan or socket: its rows wiped if it was
 * queued for deletion and came back; then, once, its existing records seeded (r6 §3.5), 1,000 a transaction from a
 * durable cursor; `ledgerSeeded` set last.  `wireOf` (sync-outbox.ts) is passed in, to keep this module's imports
 * small. */
export async function seedLedger(w: Workspace, ns: string, wireOf: (o: Op, dseq: number) => Record<string, unknown> | null): Promise<void> {
  const keys = ledgerKeys(ns);
  const run = <T>(stores: string[], f: (tx: IDBTransaction) => Promise<T>) => new Promise<T>((ok, no) => {
    const tx = w.ws.transaction(stores, "readwrite");
    let out: T;
    tx.oncomplete = () => ok(out);
    tx.onabort = tx.onerror = () => no(tx.error);
    f(tx).then((v) => { out = v; }, (e) => { try { tx.abort(); } catch {} no(e); });
  });
  // (a wipe first: the rows of a namespace that was queued and came back, a page at a time)
  for (;;) {
    const more = await run(["syncLedger", "meta"], async (tx) => {
      const meta = tx.objectStore("meta");
      if ((await req(meta.get(keys.wipe))) === undefined) return false;
      const rows = tx.objectStore("syncLedger");
      const ks = (await req(rows.getAllKeys(IDBKeyRange.bound([ns, -Infinity], [ns, Infinity]), OBSOLETE.page))) as IDBValidKey[];
      for (const key of ks) rows.delete(key);
      if (ks.length < OBSOLETE.page) {
        for (const key of [keys.wipe, keys.count, keys.floor, keys.from, keys.seeded, keys.skips, keys.seedAt]) meta.delete(key);
        return false;
      }
      return true;
    });
    if (!more) break;
  }
  if (await run(["meta"], async (tx) => (await req(tx.objectStore("meta").get(keys.seeded))) !== undefined)) return;
  // (who claims each lseq: a record owns its lseq only as its sole claimant)
  const claims = new Map<number, number>();
  for (let at = 1; ; ) {
    const page = await run(["outbox"], async (tx) => (await req(tx.objectStore("outbox").getAll(IDBKeyRange.bound([ns, at], [ns, Infinity]), LEDGER.seedPage))) as Rec[]);
    for (const r of page) if (r.lseq > 0) claims.set(r.lseq, (claims.get(r.lseq) ?? 0) + 1);
    if (page.length < LEDGER.seedPage) break;
    at = page[page.length - 1].dseq + 1;
  }
  for (;;) {
    const done = await run(["outbox", "ops", "syncLedger", "meta"], async (tx) => {
      const meta = tx.objectStore("meta"), ops = tx.objectStore("ops");
      if ((await req(meta.get(keys.from))) === undefined) meta.put(((await req(meta.get(k(ns, "scanned")))) as number | undefined) ?? 0, keys.from);
      const at = ((await req(meta.get(keys.seedAt))) as number | undefined) ?? 1;
      const page = (await req(tx.objectStore("outbox").getAll(IDBKeyRange.bound([ns, at], [ns, Infinity]), LEDGER.seedPage))) as Rec[];
      const lg = new LedgerTx(tx, ns);
      for (const r of page) {
        if (!(r.lseq > 0) || claims.get(r.lseq) !== 1) continue;
        const o = (await req(ops.get(r.lseq))) as Op | undefined;
        if (!o || o.origin === "server") continue;
        const wo = wireOf(o, r.dseq);
        if (!wo || !OWN.every((f) => wo[f] === r.op[f])) continue;
        await lg.scanned(r.lseq, "local", { dseq: r.dseq });
        if (r.accepted !== undefined) await lg.decide(r.lseq, r.dseq, "accepted");
      }
      const end = page.length < LEDGER.seedPage;
      if (end) {
        meta.put(true, keys.seeded);
        meta.delete(keys.seedAt);
      } else meta.put(page[page.length - 1].dseq + 1, keys.seedAt);
      await lg.finish();
      if (end) {
        const epoch = ((await req(meta.get("sync:epoch"))) as number | undefined) ?? 0;
        const rev = ((await req(meta.get(keys.rev))) as number | undefined) ?? 0;
        tx.addEventListener("complete", () => hubOf(w.ws).post({ t: "seeded", ns, epoch, rev }));
      }
      return end;
    });
    if (done) return;
  }
}

// ---- other namespaces' ledgers: a bounded queue, deleted a page at a time

/** In a switchTo's transaction (meta and syncLedger's keys untouched here): `from` (left) queued for deletion if it
 * has a ledger, `to` (taken) removed from the queue and its rows marked for a wipe.  Returns false if the queue has
 * no room (the switch then cleans first, and tries again). */
export async function queueObsolete(meta: IDBObjectStore, from: string | undefined, to: string): Promise<boolean> {
  let q = ((await metaGet<string[]>(meta, OBSOLETE_KEY)) ?? []).filter((n) => n !== from);
  if (q.includes(to)) {
    q = q.filter((n) => n !== to);
    meta.put(true, ledgerKeys(to).wipe);
    meta.delete(ledgerKeys(to).seeded);
  }
  if (from && from !== to && (await metaGet(meta, ledgerKeys(from).from)) !== undefined) {
    if (q.length >= OBSOLETE.max) return false;
    q.push(from);
  }
  meta.put(q, OBSOLETE_KEY);
  return true;
}
/** Whether the queue is full now. */
export async function obsoleteFull(w: Workspace): Promise<boolean> {
  return new Promise((ok, no) => {
    const r = w.ws.transaction("meta", "readonly").objectStore("meta").get(OBSOLETE_KEY);
    r.onsuccess = () => ok(((r.result as string[] | undefined) ?? []).length >= OBSOLETE.max);
    r.onerror = () => no(r.error);
  });
}
/** One cleanup step: at most OBSOLETE.page rows of the queue's first namespace deleted, in one transaction; when
 * none are left, its ledger's meta keys too, and it leaves the queue.  Returns whether anything is left. */
export async function cleanObsoleteStep(w: Workspace): Promise<boolean> {
  return new Promise((ok, no) => {
    const tx = w.ws.transaction(["syncLedger", "meta"], "readwrite");
    let left = false;
    tx.oncomplete = () => ok(left);
    tx.onabort = tx.onerror = () => no(tx.error);
    (async () => {
      const meta = tx.objectStore("meta"), rows = tx.objectStore("syncLedger");
      const q = ((await metaGet<string[]>(meta, OBSOLETE_KEY)) ?? []);
      if (!q.length) return;
      const ns = q[0];
      const ks = (await req(rows.getAllKeys(IDBKeyRange.bound([ns, -Infinity], [ns, Infinity]), OBSOLETE.page))) as IDBValidKey[];
      for (const key of ks) rows.delete(key);
      if (ks.length < OBSOLETE.page) {
        const keys = ledgerKeys(ns);
        for (const key of [keys.count, keys.floor, keys.from, keys.seeded, keys.skips, keys.seedAt, keys.wipe]) meta.delete(key);
        meta.put(q.slice(1), OBSOLETE_KEY);
        left = q.length > 1;
      } else left = true;
    })().catch((e) => { try { tx.abort(); } catch {} no(e); });
  });
}
/** The queue drained, one step at a time, under the Web Lock `sagebrush-sync-clean` (one tab at a time; another
 * holding it: nothing here).  `pause(ms)` waits between steps (the client's clock); `stopped()` ends it. */
export async function driveObsolete(w: Workspace, pause: (ms: number) => Promise<void>, stopped: () => boolean): Promise<void> {
  const locks = (globalThis.navigator as any)?.locks;
  const go = async () => {
    while (!stopped() && (await cleanObsoleteStep(w))) await pause(OBSOLETE.gapMs);
  };
  if (!locks?.request) return go();
  await locks.request("sagebrush-sync-clean", { ifAvailable: true }, (lock: unknown) => (lock ? go() : undefined));
}
