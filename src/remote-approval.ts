// Approval and provenance for remote runs (the remote-compute plan, §3): what
// the page lets it send to a remote kernel, and when.  The page is the only
// approval boundary: the gateway keeps no queue, so every run it executes was
// checked here at the moment it was sent.
//
//   - eid, a cell's execution identity: the hash of what would run (binding,
//     cell, mode, the code that runs, its options).  Approving a cell approves
//     that eid, for the current approval epoch.
//   - S(B), a queued cell's structural witness: its closure's cell ids,
//     eids and edges, frozen when it is queued.  It holds no run ids, so an
//     ancestor finishing its planned run doesn't change it.
//   - vid, a successful run's provenance id: the hash of its execution
//     identity xi (binding, incarnation, request, cell, batch index), its eid
//     and its parents' vids as they were when it was sent (pi).  A rerun of
//     the same code is a new request, hence a new vid, so what was computed
//     from the old run is no longer valid.
//   - The submit check: a cell goes out only if nothing it was queued under
//     changed (approvals, the document, its code, its closure's structure,
//     the kernel) and every ancestor is provenance-valid now; if an ancestor
//     only has to run (again) first, it waits.
//
// Coherence.  Hashing is asynchronous, and anything can change while a hash
// is computed.  So every operation works on one snapshot, taken
// synchronously at its start (the approval epoch, the document, the kernel,
// each involved cell's revision: its code, mode, options, parents, and its
// success record), computes only from that snapshot, and commits only if a
// fresh snapshot taken synchronously at the end is identical:
//   - approveCells approves all of its cells, as they were at its start, or
//     none (a reset, a replaced document or an edit to any listed cell
//     during it aborts it);
//   - check returns a plan with a token naming its snapshot; the caller must
//     admit() it synchronously, in the same turn as the send, and admit()
//     fails, sending nothing, if anything changed since (a token is consumed
//     once);
//   - each admitted attempt has a number; a terminal (succeeded, failed)
//     applies only to the cell's latest admitted attempt, in the records'
//     generation (clearRecords starts a new one), approval epoch and
//     document it was admitted in, and only once.
//
// Pure logic: the graph and the hash are the host's (the reactive engine's
// graph, src/notebook-graph.ts; SHA-256, hex), so this runs in the page and
// in tests alike.  JCS is RFC 8785 canonical JSON.

/** SHA-256 of a text's UTF-8 bytes, as hex. */
export type Hash = (text: string) => Promise<string>;

/** RFC 8785 canonical JSON of a JSON value: object keys sorted by UTF-16 code units, numbers as ECMAScript writes them. */
export function jcs(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("JCS: a number must be finite");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new TypeError(`JCS: not a JSON value (${typeof v})`);
}

/** What a run of a cell is given besides its code (the reactive engine's options). */
export interface ExecOptions {
  seed?: string | null;
  forget?: string[] | null;
  mangle?: string | null;
  scoped?: Record<string, string> | null;
}

/** The graph as it is now: the host's view of the reactive engine. */
export interface ApprovalGraph {
  /** a cell's direct parents */
  parents(id: string): Iterable<string>;
  /** a cell's ancestors (its whole dependency closure, without itself) */
  ancestors(id: string): Iterable<string>;
  /** what would run for a cell now (the code after page-order scoping), or undefined if it is gone */
  cell(id: string): { source: string; mode: string; options: ExecOptions } | undefined;
}

/** The kernel the page is bound to now. */
export interface KernelContext {
  binding: string | null;
  epoch: number | null;
  generation: number;
  incarnation: number | null;
  /** the grant connected and the binding ready */
  ready: boolean;
}

/** A successful run's execution identity. */
export interface ExecutionIdentity {
  binding: string;
  incarnation: number | null;
  request: string;
  cell: string;
  batch: number;
}

/** What a user run that ended ok leaves: the record its descendants are checked against. */
export interface SuccessRecord {
  eid: string;
  xi: ExecutionIdentity;
  /** the parents' vids when it was sent, sorted by parent id */
  pi: [string, string][];
  vid: string;
  /** the attempt that wrote it */
  attempt: number;
}

/** What is frozen when a cell (or a batch) is queued. */
export interface Frozen {
  /** the cells, in batch order (one for a single run) */
  cells: string[];
  eids: string[];
  approvalEpoch: number;
  doc: string;
  binding: string | null;
  epoch: number | null;
  generation: number;
  witness: string;
}

/** One cell of an approved submission: what it is sent as, and the record it will leave if it succeeds. */
export interface Planned {
  cell: string;
  eid: string;
  xi: ExecutionIdentity;
  pi: [string, string][];
  vid: string;
  /** this attempt's number (monotone, set by admit) and the scope it belongs to: its terminal applies only in it */
  attempt: number;
  recordsGeneration: number;
  approvalEpoch: number;
  doc: string;
}

/** A send verdict's admission token: the snapshot it was computed on; consumed by admit(). */
export interface PlanToken {
  readonly cells: string[];
  readonly key: string;
  consumed: boolean;
}

export type Verdict =
  | { send: true; plan: Planned[]; token: PlanToken }
  /** an ancestor has to run (again) first: the engine runs it, then this */
  | { send: false; wait: string }
  /** something it was queued under changed: not sent, and never rebuilt; the engine replans */
  | { send: false; skip: string };

// One cell in a snapshot: what would run and its edges, and its success record.
interface CellRev {
  cell: { source: string; mode: string; options: ExecOptions } | undefined;
  parents: string[];
  record: SuccessRecord | undefined;
}
// A snapshot: everything an operation depends on, taken synchronously.
interface Snapshot {
  key: string;
  ctx: KernelContext;
  approvalEpoch: number;
  doc: string;
  recordsGeneration: number;
  /** each submitted cell's ancestors */
  ancestors: Map<string, string[]>;
  /** every cell involved (the submitted cells and their ancestors) */
  cells: Map<string, CellRev>;
}

const byId = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};
const optionsJson = (o: ExecOptions | undefined) => ({
  seed: o?.seed ?? null,
  forget: o?.forget ? [...o.forget] : null,
  mangle: o?.mangle ?? null,
  scoped: o?.scoped ? { ...o.scoped } : null,
});
const recordJson = (r: SuccessRecord | undefined) => (r ? { vid: r.vid, attempt: r.attempt } : null);

export class Approvals {
  /** reset to a new epoch (approvals forgotten) by a load, a replace, a rebind, a takeover, a target or account change */
  approvalEpoch = 0;
  /** the document's identity: new on each load or replace */
  doc: string;
  private readonly hash: Hash;
  private readonly graph: ApprovalGraph;
  private readonly context: () => KernelContext;
  private readonly newDoc: () => string;
  // (within an epoch approvals are only ever added, and an added approval can't make a send verdict
  // wrong: so the approved set isn't part of a snapshot, its epoch is)
  private approved = new Set<string>();
  private records = new Map<string, SuccessRecord>();
  private recordsGeneration = 0;
  private attempts = 0;
  /** each cell's latest admitted attempt */
  private latest = new Map<string, number>();
  /** each cell's last attempt whose terminal was applied (a duplicate terminal changes nothing) */
  private settled = new Map<string, number>();
  private eidCache = new Map<string, string>();

  constructor(hash: Hash, graph: ApprovalGraph, context: () => KernelContext, newDoc?: () => string) {
    this.hash = hash;
    this.graph = graph;
    this.context = context;
    this.newDoc = newDoc ?? (() => Math.random().toString(36).slice(2) + Date.now().toString(36));
    this.doc = this.newDoc();
  }

  // The snapshot of `ids` and their ancestors, now (synchronous).
  private snap(ids: string[]): Snapshot {
    const c = this.context();
    const ctx: KernelContext = { binding: c.binding, epoch: c.epoch, generation: c.generation, incarnation: c.incarnation, ready: c.ready };
    const ancestors = new Map<string, string[]>();
    const all = new Set<string>(ids);
    for (const id of ids) {
      const a = [...this.graph.ancestors(id)].sort();
      ancestors.set(id, a);
      for (const x of a) all.add(x);
    }
    const cells = new Map<string, CellRev>();
    for (const id of [...all].sort()) {
      const cell = this.graph.cell(id);
      cells.set(id, {
        cell: cell ? { source: cell.source, mode: cell.mode, options: optionsJson(cell.options) } : undefined,
        parents: [...this.graph.parents(id)].sort(),
        record: this.records.get(id),
      });
    }
    const key = jcs({
      approvalEpoch: this.approvalEpoch, doc: this.doc, recordsGeneration: this.recordsGeneration, ctx,
      ids, ancestors: [...ancestors],
      cells: [...cells].map(([id, r]) => [id, r.cell ? { source: r.cell.source, mode: r.cell.mode, options: r.cell.options } : null, r.parents, recordJson(r.record)]),
    });
    return { key, ctx, approvalEpoch: this.approvalEpoch, doc: this.doc, recordsGeneration: this.recordsGeneration, ancestors, cells };
  }

  // What a consent depends on, now (synchronous): the approval epoch, the document, the kernel, and
  // exactly the listed cells' bytes (not their ancestors or records: those don't change what was consented to).
  private consent(ids: string[]): string {
    const c = this.context();
    return jcs({
      approvalEpoch: this.approvalEpoch, doc: this.doc,
      ctx: { binding: c.binding, epoch: c.epoch, generation: c.generation, incarnation: c.incarnation, ready: c.ready },
      cells: ids.map((id) => {
        const x = this.graph.cell(id);
        return [id, x ? { source: x.source, mode: x.mode, options: optionsJson(x.options) } : null];
      }),
    });
  }

  // A cell's eid in a snapshot (undefined if the cell is gone or nothing is bound).
  private async eidIn(s: Snapshot, id: string): Promise<string | undefined> {
    const c = s.cells.get(id)?.cell;
    if (!c || s.ctx.binding === null) return undefined;
    const text = jcs(["eid", 1, s.ctx.binding, id, c.mode, c.source, optionsJson(c.options)]);
    let h = this.eidCache.get(text);
    if (h === undefined) {
      h = await this.hash(text);
      if (this.eidCache.size > 10_000) this.eidCache.clear();
      this.eidCache.set(text, h);
    }
    return h;
  }

  /** A cell's eid now (undefined if the cell is gone or the page isn't bound). */
  async eid(id: string): Promise<string | undefined> {
    return this.eidIn(this.snap([id]), id);
  }

  isApproved(eid: string | undefined): boolean {
    return eid !== undefined && this.approved.has(eid);
  }

  /**
   * Approve exactly these cells as they are at the call (the person ran or
   * typed them, or ran a listed closure): all of them, or none if the
   * approval epoch, the document, the kernel or any listed cell's code,
   * mode or options changed while it was hashing.  Resolves to whether they were approved.
   */
  async approveCells(ids: Iterable<string>): Promise<boolean> {
    const list = [...ids];
    const s = this.snap(list);
    const consent = this.consent(list);
    const eids: string[] = [];
    for (const id of list) {
      const e = await this.eidIn(s, id);
      if (e === undefined) return false;
      eids.push(e);
    }
    // (the commit: only if nothing it depends on changed meanwhile)
    if (this.consent(list) !== consent) return false;
    for (const e of eids) this.approved.add(e);
    return true;
  }

  /** A new approval epoch: every approval is forgotten.  `newDocument`: a load or replace (the document's identity changes too). */
  reset({ newDocument = false } = {}): void {
    this.approvalEpoch++;
    this.approved.clear();
    if (newDocument) this.doc = this.newDoc();
  }
  /** Forget every success record (a new incarnation, a takeover, a join, a quarantine): terminals of earlier attempts no longer apply. */
  clearRecords(): void {
    this.records.clear();
    this.recordsGeneration++;
  }

  /** The record a cell's last successful run left, if any. */
  record(id: string): SuccessRecord | undefined {
    return this.records.get(id);
  }

  // S over a snapshot's closure: the cells with their eids (null if gone), and the edges among them.
  private async witnessIn(s: Snapshot, eids: Map<string, string | undefined>): Promise<string> {
    const cells: [string, string | null][] = [];
    const edges: [string, string][] = [];
    for (const [id, r] of s.cells) {
      cells.push([id, eids.get(id) ?? null]);
      for (const p of r.parents) edges.push([p, id]);
    }
    edges.sort((a, b) => (a[0] + "\u0000" + a[1] < b[0] + "\u0000" + b[1] ? -1 : 1));
    return this.hash(jcs(["S", 1, cells, edges]));
  }

  private async eidsIn(s: Snapshot): Promise<Map<string, string | undefined>> {
    const eids = new Map<string, string | undefined>();
    for (const id of s.cells.keys()) eids.set(id, await this.eidIn(s, id));
    return eids;
  }

  /**
   * Freeze a cell, or a batch (in its order), as it is queued: computed
   * entirely on one snapshot, so it is coherent even if something changes
   * meanwhile (then check() finds the change and skips it).
   */
  async freeze(ids: string[]): Promise<Frozen> {
    const s = this.snap(ids);
    const eids = await this.eidsIn(s);
    const witness = await this.witnessIn(s, eids);
    return {
      cells: [...ids], eids: ids.map((id) => eids.get(id) ?? ""), approvalEpoch: s.approvalEpoch, doc: s.doc,
      binding: s.ctx.binding, epoch: s.ctx.epoch, generation: s.ctx.generation, witness,
    };
  }

  // Provenance validity in a snapshot (the plan's §3.2): a record in its
  // binding and incarnation, for the cell's eid there, approved, with the
  // parents it has there, each of them valid with the vid the record names.
  private validIn(s: Snapshot, eids: Map<string, string | undefined>): (id: string) => boolean {
    const memo = new Map<string, boolean>();
    const valid = (id: string): boolean => {
      const m = memo.get(id);
      if (m !== undefined) return m;
      memo.set(id, false); // (a cycle is never valid)
      const rev = s.cells.get(id);
      const r = rev?.record;
      const e = eids.get(id);
      let ok = !!rev && !!r && r.xi.binding === s.ctx.binding && r.xi.incarnation === s.ctx.incarnation && r.eid === e && this.isApproved(e);
      if (ok) {
        ok = sameSet(rev!.parents, r!.pi.map(([p]) => p)) &&
          r!.pi.every(([p, v]) => valid(p) && s.cells.get(p)?.record?.vid === v);
      }
      memo.set(id, ok);
      return ok;
    };
    return valid;
  }

  /**
   * The submit check, computed on one snapshot (approvals included: adding
   * one meanwhile makes it stale too).  `request`: the run's
   * request id (one per submission; a batch's cells are its batch indexes).
   * A send verdict must then be admit()ted, synchronously, right before the
   * send.
   */
  async check(frozen: Frozen, request: string): Promise<Verdict> {
    const s = this.snap(frozen.cells);
    // 1. the approvals and the document it was queued under
    if (s.approvalEpoch !== frozen.approvalEpoch || s.doc !== frozen.doc) return { send: false, skip: "approvals were reset or the notebook was replaced" };
    // 5. the kernel it was queued for, still bound and ready
    const ctx = s.ctx;
    if (!ctx.ready || ctx.binding === null || ctx.binding !== frozen.binding || ctx.epoch !== frozen.epoch || ctx.generation !== frozen.generation) {
      return { send: false, skip: "the kernel changed" };
    }
    const binding: string = ctx.binding;
    const eids = await this.eidsIn(s);
    // 2. its own code, unchanged and approved (approvals are only ever removed by a reset, which 1 catches)
    for (let i = 0; i < frozen.cells.length; i++) {
      const e = eids.get(frozen.cells[i]);
      if (e === undefined || e !== frozen.eids[i] || !this.isApproved(e)) return { send: false, skip: "the cell changed, or is not approved" };
    }
    // 3. the structure of its closure, unchanged
    if ((await this.witnessIn(s, eids)) !== frozen.witness) return { send: false, skip: "a cell it depends on changed" };
    // 4. every ancestor outside the submission provenance-valid; inside it, earlier in batch order
    const inBatch = new Map(frozen.cells.map((id, i) => [id, i]));
    for (let i = 0; i < frozen.cells.length; i++) {
      for (const p of s.cells.get(frozen.cells[i])!.parents) {
        const j = inBatch.get(p);
        if (j !== undefined && j >= i) return { send: false, skip: "the batch is not in dependency order" };
      }
    }
    const outside = new Set<string>();
    for (const id of frozen.cells) for (const a of s.ancestors.get(id)!) if (!inBatch.has(a)) outside.add(a);
    const valid = this.validIn(s, eids);
    for (const a of [...outside].sort()) {
      if (!valid(a)) return { send: false, wait: `an ancestor has to run first (${a})` };
    }
    // the plan: each cell's identity, its parents' vids as they will be when it runs (a parent earlier
    // in the batch contributes the vid it will have if it succeeds), and its own vid
    const planned = new Map<string, string>();
    const plan: Planned[] = [];
    for (let i = 0; i < frozen.cells.length; i++) {
      const cell = frozen.cells[i];
      const xi: ExecutionIdentity = { binding, incarnation: ctx.incarnation, request, cell, batch: i };
      const pi = s.cells.get(cell)!.parents.map((p) => [p, planned.get(p) ?? s.cells.get(p)!.record!.vid] as [string, string]).sort(byId);
      const eid = eids.get(cell)!;
      const vid = await this.hash(jcs(["vid", 2, xi, eid, pi]));
      planned.set(cell, vid);
      plan.push({ cell, eid, xi, pi, vid, attempt: 0, recordsGeneration: s.recordsGeneration, approvalEpoch: s.approvalEpoch, doc: s.doc });
    }
    // (computed on the snapshot only if it is still the state now: anything changed while hashing, and it's stale)
    if (this.snap(frozen.cells).key !== s.key) return { send: false, skip: "something changed while it was being checked" };
    return { send: true, plan, token: { cells: [...frozen.cells], key: s.key, consumed: false } };
  }

  /**
   * Consume a send verdict, synchronously, in the same turn as the send:
   * true (send it now) only if this is the token's first use and nothing it
   * was computed on has changed since.  Numbers each planned cell's
   * attempt, and drops the planned cells' records: while a cell runs
   * again, what was computed from its previous run is not valid (its
   * descendants wait for this attempt's terminal).
   */
  admit(v: Verdict): boolean {
    if (!v.send || v.token.consumed) return false;
    if (this.snap(v.token.cells).key !== v.token.key) return false;
    v.token.consumed = true;
    for (const p of v.plan) {
      p.attempt = ++this.attempts;
      this.latest.set(p.cell, p.attempt);
      this.records.delete(p.cell);
    }
    return true;
  }

  // Does a terminal for this planned attempt apply?  Only for an admitted attempt that is the cell's
  // latest, in the records' generation, approval epoch and document it was admitted in, and the first
  // terminal for it.  (One that doesn't apply leaves no record: admit() dropped the cell's previous one,
  // so its descendants wait for a newer run.)
  private applies(p: Planned): boolean {
    return p.attempt > 0 && this.latest.get(p.cell) === p.attempt && this.settled.get(p.cell) !== p.attempt &&
      p.recordsGeneration === this.recordsGeneration && p.approvalEpoch === this.approvalEpoch && p.doc === this.doc;
  }

  /**
   * A planned cell's user run ended ok: its record, exactly as planned (the
   * frozen identity and parents).  Ignored for an older attempt, one from
   * before clearRecords or a reset, or a duplicate.  Returns whether it applied.
   */
  succeeded(p: Planned): boolean {
    if (!this.applies(p)) return false;
    this.settled.set(p.cell, p.attempt);
    this.records.set(p.cell, { eid: p.eid, xi: { ...p.xi }, pi: p.pi.map(([a, b]) => [a, b] as [string, string]), vid: p.vid, attempt: p.attempt });
    return true;
  }
  /** A planned cell's run ended with anything but a user-phase ok: its record is gone (its descendants wait for it); the same fences as succeeded. */
  failed(p: Planned): boolean {
    if (!this.applies(p)) return false;
    this.settled.set(p.cell, p.attempt);
    this.records.delete(p.cell);
    return true;
  }
}
