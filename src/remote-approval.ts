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
}

export type Verdict =
  | { send: true; plan: Planned[] }
  /** an ancestor has to run (again) first: the engine runs it, then this */
  | { send: false; wait: string }
  /** something it was queued under changed: not sent, and never rebuilt; the engine replans */
  | { send: false; skip: string };

const byId = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

export class Approvals {
  /** reset to a new epoch (approvals forgotten) by a load, a replace, a rebind, a takeover, a target or account change */
  approvalEpoch = 0;
  /** the document's identity: new on each load or replace */
  doc: string;
  private approved = new Set<string>();
  private records = new Map<string, SuccessRecord>();
  private eidCache = new Map<string, string>();

  constructor(
    private readonly hash: Hash,
    private readonly graph: ApprovalGraph,
    private context: () => KernelContext,
    private readonly newDoc: () => string = () => Math.random().toString(36).slice(2) + Date.now().toString(36),
  ) {
    this.doc = this.newDoc();
  }

  /** A cell's eid now (undefined if the cell is gone or the page isn't bound). */
  async eid(id: string): Promise<string | undefined> {
    const c = this.graph.cell(id);
    const binding = this.context().binding;
    if (!c || binding === null) return undefined;
    const o = c.options ?? {};
    const text = jcs([
      "eid", 1, binding, id, c.mode, c.source,
      { seed: o.seed ?? null, forget: o.forget ? [...o.forget] : null, mangle: o.mangle ?? null, scoped: o.scoped ? { ...o.scoped } : null },
    ]);
    let h = this.eidCache.get(text);
    if (h === undefined) {
      h = await this.hash(text);
      if (this.eidCache.size > 10_000) this.eidCache.clear();
      this.eidCache.set(text, h);
    }
    return h;
  }

  /** Approve an eid for this approval epoch (the person ran or typed exactly that). */
  approve(eid: string): void {
    this.approved.add(eid);
  }
  /** Approve exactly these cells as they are now (an explicit Run of a listed closure). */
  async approveCells(ids: Iterable<string>): Promise<void> {
    for (const id of ids) {
      const e = await this.eid(id);
      if (e) this.approve(e);
    }
  }
  isApproved(eid: string | undefined): boolean {
    return eid !== undefined && this.approved.has(eid);
  }

  /** A new approval epoch: every approval is forgotten.  `newDocument`: a load or replace (the document's identity changes too). */
  reset({ newDocument = false } = {}): void {
    this.approvalEpoch++;
    this.approved.clear();
    if (newDocument) this.doc = this.newDoc();
  }
  /** Forget every success record (a new incarnation, a takeover, a join, a quarantine). */
  clearRecords(): void {
    this.records.clear();
  }

  /** The record a cell's last successful run left, if any. */
  record(id: string): SuccessRecord | undefined {
    return this.records.get(id);
  }

  // S over the closures of `ids` (each with its ancestors): the cells with
  // their eids (null if gone), and the edges among them.
  private async witness(ids: string[]): Promise<string> {
    const closure = new Set<string>();
    for (const id of ids) {
      closure.add(id);
      for (const a of this.graph.ancestors(id)) closure.add(a);
    }
    const cells: [string, string | null][] = [];
    const edges: [string, string][] = [];
    for (const id of [...closure].sort()) {
      cells.push([id, (await this.eid(id)) ?? null]);
      for (const p of this.graph.parents(id)) edges.push([p, id]);
    }
    edges.sort((a, b) => (a[0] + "\u0000" + a[1] < b[0] + "\u0000" + b[1] ? -1 : 1));
    return this.hash(jcs(["S", 1, cells, edges]));
  }

  /** Freeze a cell, or a batch (in its order), as it is queued. */
  async freeze(ids: string[]): Promise<Frozen> {
    const ctx = this.context();
    const eids: string[] = [];
    for (const id of ids) eids.push((await this.eid(id)) ?? "");
    return {
      cells: [...ids], eids, approvalEpoch: this.approvalEpoch, doc: this.doc,
      binding: ctx.binding, epoch: ctx.epoch, generation: ctx.generation,
      witness: await this.witness(ids),
    };
  }

  // Provenance validity now (the plan's §3.2): a record in this binding and
  // incarnation, for the cell's current, approved eid, with the parents it
  // has now, each of them valid with the vid the record names.
  private async validNow(eids: Map<string, string | undefined>): Promise<(id: string) => boolean> {
    const ctx = this.context();
    const memo = new Map<string, boolean>();
    const valid = (id: string): boolean => {
      const m = memo.get(id);
      if (m !== undefined) return m;
      memo.set(id, false); // (a cycle is never valid)
      const r = this.records.get(id);
      const e = eids.get(id);
      let ok = !!r && r.xi.binding === ctx.binding && r.xi.incarnation === ctx.incarnation && r.eid === e && this.isApproved(e);
      if (ok) {
        const parents = [...this.graph.parents(id)];
        ok = sameSet(parents, r!.pi.map(([p]) => p)) &&
          r!.pi.every(([p, v]) => valid(p) && this.records.get(p)?.vid === v);
      }
      memo.set(id, ok);
      return ok;
    };
    return valid;
  }

  /**
   * The submit check, at the moment of sending.  `request`: the run's
   * request id (one per submission; a batch's cells are its batch indexes).
   */
  async check(frozen: Frozen, request: string): Promise<Verdict> {
    const ctx = this.context();
    // 1. the approvals and the document it was queued under
    if (this.approvalEpoch !== frozen.approvalEpoch || this.doc !== frozen.doc) return { send: false, skip: "approvals were reset or the notebook was replaced" };
    // 5. the kernel it was queued for, still bound and ready
    if (!ctx.ready || ctx.binding === null || ctx.binding !== frozen.binding || ctx.epoch !== frozen.epoch || ctx.generation !== frozen.generation) {
      return { send: false, skip: "the kernel changed" };
    }
    // 2. its own code, unchanged and approved
    const eids = new Map<string, string | undefined>();
    for (let i = 0; i < frozen.cells.length; i++) {
      const id = frozen.cells[i];
      const e = await this.eid(id);
      if (e === undefined || e !== frozen.eids[i] || !this.isApproved(e)) return { send: false, skip: "the cell changed, or is not approved" };
      eids.set(id, e);
    }
    // 3. the structure of its closure, unchanged
    if ((await this.witness(frozen.cells)) !== frozen.witness) return { send: false, skip: "a cell it depends on changed" };
    // 4. every ancestor outside the submission provenance-valid now; inside it, earlier in batch order
    const inBatch = new Map(frozen.cells.map((id, i) => [id, i]));
    const outside = new Set<string>();
    for (const id of frozen.cells) for (const a of this.graph.ancestors(id)) if (!inBatch.has(a)) outside.add(a);
    for (const a of outside) eids.set(a, await this.eid(a));
    const valid = await this.validNow(eids);
    for (let i = 0; i < frozen.cells.length; i++) {
      for (const p of this.graph.parents(frozen.cells[i])) {
        const j = inBatch.get(p);
        if (j !== undefined && j >= i) return { send: false, skip: "the batch is not in dependency order" };
      }
    }
    for (const a of [...outside].sort()) {
      if (!valid(a)) return { send: false, wait: `an ancestor has to run first (${a})` };
    }
    // the plan: each cell's identity, its parents' vids as they will be when it runs (a parent earlier
    // in the batch contributes the vid it will have if it succeeds), and its own vid
    const planned = new Map<string, string>();
    const plan: Planned[] = [];
    for (let i = 0; i < frozen.cells.length; i++) {
      const cell = frozen.cells[i];
      const xi: ExecutionIdentity = { binding: ctx.binding, incarnation: ctx.incarnation, request, cell, batch: i };
      const pi: [string, string][] = [...this.graph.parents(cell)].map((p) => [p, planned.get(p) ?? this.records.get(p)!.vid] as [string, string]).sort(byId);
      const eid = eids.get(cell)!;
      const vid = await this.hash(jcs(["vid", 2, xi, eid, pi]));
      planned.set(cell, vid);
      plan.push({ cell, eid, xi, pi, vid });
    }
    return { send: true, plan };
  }

  /**
   * A planned cell's user run ended ok: its record, exactly as planned (the
   * frozen identity and parents).  A duplicate or recovered terminal for the
   * same request writes the same record again: nothing new.
   */
  succeeded(p: Planned): void {
    this.records.set(p.cell, { eid: p.eid, xi: { ...p.xi }, pi: p.pi.map(([a, b]) => [a, b] as [string, string]), vid: p.vid });
  }
  /** A cell's run ended with anything but a user-phase ok: its record is gone (its descendants wait for it). */
  failed(id: string): void {
    this.records.delete(id);
  }
}
