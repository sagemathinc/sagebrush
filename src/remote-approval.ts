// Approval and provenance for remote runs, and their integration with the
// reactive scheduler and the send path: what the page lets it send to a
// remote kernel, and when.  The page is the only approval boundary: the gateway keeps no
// queue, so every run it executes was checked here at the moment it was sent.
//
//   - A run spec: one frozen object per cell holding exactly what would run
//     (binding, cell, mode, the code that runs, its options).  The host makes
//     a new object only when one of those changes, so the object's identity
//     stands for its bytes.
//   - eid, a cell's execution identity: the hash of its spec's canonical
//     text.  It is kept in a memo keyed by the spec object (never written on
//     it), so an eid can't be paired with other bytes.  Approving a cell
//     approves its eid, for the current approval epoch, and only through a
//     person's consent (captureConsent at the gesture, checked in stages).
//   - S(B), a queued cell's structural witness, per cell and Merkle-shaped
//     (S v2): h(c) commits to c's id, its eid and its parents' h.  It holds
//     no run ids, so an ancestor finishing its planned run doesn't change it.
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
// synchronously (the approval epoch, the document, the kernel's fields, and
// for each cell involved its spec object, its parents array and its success
// record, all compared by identity), computes only from it, and commits only
// if a fresh snapshot is the same:
//   - a person's consent is a single-use capability captured at the gesture
//     (what was on screen, compared once with each cell's text version),
//     checked at each stage by identity (the text versions, the settings
//     object, the registrations, the seeds) until approveCells commits it,
//     all or nothing, after comparing the displayed text and the settings
//     with what was captured, by value;
//   - check returns a plan with a token naming its snapshot; the token is
//     admitted (admit) synchronously right before the fetch that sends it,
//     once, and a retry of that same send only while stillAdmitted holds;
//   - each admitted attempt has a number; a terminal (succeeded, failed)
//     applies only to the cell's latest admitted attempt, in the records'
//     generation (clearRecords starts a new one), approval epoch and
//     document it was admitted in, and only once; forgotten() fences a
//     cell's pending attempts when its names are deleted.
//
// Limits.  An action (one step of the reactive scheduler) has one budget,
// with a counter per kind of work: the three content comparisons (the
// click, the commit, the send: UTF-16 code units), run outputs compared
// again (rekeyUnits), canonical bytes scanned and built, eid, S and vid
// hashes, snapshot visits.  Every comparison sums its lengths first and
// compares nothing if the sum doesn't fit.  Before anything is built,
// hashed or sent, precount() plans the whole action and refuses it if it
// can't fit; structural caps (cells, edges, ids, one cell's size) are
// checked as snapshots are walked.  Over any of them: "too large for one
// remote action".
//
// Pure logic: the graph and the hash are the host's (web/notebook/remote-gate.js
// in the page; SHA-256, hex), so this runs in the page and in tests alike.
// JCS is RFC 8785 canonical JSON.

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

// The UTF-8 length of JSON.stringify(s), without building it.
function stringBytes(s: string): number {
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) n += 2;
    else if (c < 0x20) n += 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 6; // (a lone surrogate is written \udxxx)
    } else if (c >= 0xdc00 && c <= 0xdfff) n += 6;
    else n += 3;
  }
  return n;
}

/** The exact UTF-8 byte length of jcs(v), counted without building the text. */
export function jcsBytes(v: unknown): number {
  if (v === null) return 4;
  if (typeof v === "boolean") return v ? 4 : 5;
  if (typeof v === "string") return stringBytes(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("JCS: a number must be finite");
    return JSON.stringify(v).length;
  }
  if (Array.isArray(v)) {
    let n = 2 + Math.max(0, v.length - 1);
    for (const x of v) n += jcsBytes(x);
    return n;
  }
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const keys = Object.keys(v as object);
    let n = 2 + Math.max(0, keys.length - 1);
    for (const k of keys) n += stringBytes(k) + 1 + jcsBytes((v as Record<string, unknown>)[k]);
    return n;
  }
  throw new TypeError(`JCS: not a JSON value (${typeof v})`);
}

// UTF-8 length of a string (ids).
function utf8Bytes(s: string): number {
  return stringBytes(s) - 2; // (ids hold no characters JSON escapes; an overcount only refuses earlier)
}

/** What a run of a cell is given besides its code (the reactive engine's options). */
export interface ExecOptions {
  seed?: string | null;
  forget?: readonly string[] | null;
  mangle?: string | null;
  scoped?: Readonly<Record<string, string>> | null;
}

/** A cell's options in a run spec: normalized (empty lists and maps are null) and frozen. */
export interface RunOptions {
  readonly seed: string | null;
  readonly forget: readonly string[] | null;
  readonly mangle: string | null;
  readonly scoped: Readonly<Record<string, string>> | null;
}

/** Exactly what would run for a cell: a frozen object, made anew whenever anything in it changes. */
export interface RunSpec {
  readonly id: string;
  /** the code that runs (page-order scoping's renames applied) */
  readonly source: string;
  readonly mode: string;
  readonly options: RunOptions;
  readonly binding: string;
}

/** A frozen run spec. */
export function makeSpec(id: string, source: string, mode: string, options: ExecOptions, binding: string): RunSpec {
  const o: RunOptions = Object.freeze({
    seed: options.seed ?? null,
    forget: options.forget && options.forget.length ? Object.freeze([...options.forget]) : null,
    mangle: options.mangle ?? null,
    scoped: options.scoped && Object.keys(options.scoped).length ? Object.freeze({ ...options.scoped }) : null,
  });
  return Object.freeze({ id, source, mode, options: o, binding });
}

// The canonical value whose hash is a spec's eid.
function eidValue(s: RunSpec): unknown {
  const o = s.options;
  return ["eid", 1, s.binding, s.id, s.mode, s.source, { seed: o.seed, forget: o.forget, mangle: o.mangle, scoped: o.scoped }];
}

/** The graph as it is now: the host's view of the reactive engine. */
export interface ApprovalGraph {
  /** a cell's current run spec (the same object while nothing in it changed), or undefined if it is gone, not runnable, or nothing is bound */
  spec(id: string): RunSpec | undefined;
  /** a cell's direct parents, sorted (the same array object while they are unchanged) */
  parents(id: string): readonly string[];
}

/** The kernel the page is bound to now. */
export interface KernelContext {
  binding: string | null;
  /**
   * the page's lineage (remote-kernel.js lc.own): it changes with every transition of the kernel record except a
   * fence the gateway attests as continuous (plan r8 F1), so a consent captured before such a fence still holds
   */
  own: number;
  generation: number;
  incarnation: number | null;
  /** the grant connected and the binding ready */
  ready: boolean;
}
const CTX_FIELDS = ["binding", "own", "generation", "incarnation", "ready"] as const;

/** A successful run's execution identity. */
export interface ExecutionIdentity {
  binding: string;
  incarnation: number | null;
  request: string;
  cell: string;
  batch: number;
}

/** What a user run that ended ok leaves: the record its descendants are checked against (a new object each time). */
export interface SuccessRecord {
  readonly eid: string;
  readonly xi: Readonly<ExecutionIdentity>;
  /** the parents' vids when it was sent, sorted by parent id */
  readonly pi: readonly (readonly [string, string])[];
  readonly vid: string;
  /** the attempt that wrote it */
  readonly attempt: number;
}

/** What is frozen when a cell (or a batch) is queued. */
export interface Frozen {
  /** the cells, in batch order (one for a single run) */
  cells: string[];
  eids: string[];
  approvalEpoch: number;
  doc: string;
  binding: string | null;
  own: number;
  generation: number;
  /** S v2, or null: the closure has a cycle */
  witness: string | null;
}

/** One cell of an approved submission: what it is sent as, and the record it will leave if it succeeds. */
export interface Planned {
  cell: string;
  eid: string;
  /** exactly what is sent: the checked spec */
  run: RunSpec;
  xi: ExecutionIdentity;
  pi: [string, string][];
  vid: string;
  /** this attempt's number (monotone, set by admit) and the scope it belongs to: its terminal applies only in it */
  attempt: number;
  recordsGeneration: number;
  approvalEpoch: number;
  doc: string;
}

// One cell in a snapshot: by identity.
interface CellSnap {
  readonly spec: RunSpec | undefined;
  readonly parents: readonly string[];
  readonly record: SuccessRecord | undefined;
}
// A snapshot: everything an operation depends on, taken synchronously.
interface Snapshot {
  readonly ids: readonly string[];
  readonly approvalEpoch: number;
  readonly doc: string;
  readonly recordsGeneration: number;
  readonly ctx: Readonly<KernelContext>;
  readonly cells: ReadonlyMap<string, CellSnap>;
  readonly edges: number;
}

/** A send verdict's admission token: the snapshot it was computed on; admit() consumes it once. */
export interface PlanToken {
  readonly cells: string[];
  readonly snapshot: Snapshot;
  consumed: boolean;
  /** the snapshot right after its admission (what a retry of the same send must still find) */
  admittedSnapshot?: Snapshot;
}

export type Verdict =
  | { send: true; plan: Planned[]; token: PlanToken }
  /** an ancestor has to run (again) first: the engine runs it, then this */
  | { send: false; wait: string }
  /** something it was queued under changed (or it is too large): not sent, and never rebuilt; the engine replans */
  | { send: false; skip: string };

// ---------------------------------------------------------------- limits

/** Structural caps, checked as a snapshot is walked (before anything is built or hashed). */
export const CAPS = Object.freeze({
  /** cells in one submission's closure */
  cells: 5000,
  /** parent edges in one submission's closure */
  edges: 50_000,
  /** one cell id, and a closure's ids together (UTF-8 bytes) */
  idBytes: 256,
  idTotalBytes: 1 << 20,
  /** one cell's canonical eid input (exact UTF-8 bytes) */
  eidInputBytes: 2 << 20,
  /** one S v2 node's canonical input */
  sNodeInputBytes: 64 << 10,
  /** one cell's forget list: names, and their UTF-16 code units together */
  forgetNames: 4096,
  forgetUnits: 64 << 10,
  /** one cell's scoped map: entries, and their keys' and values' UTF-16 code units together */
  scopedEntries: 4096,
  scopedUnits: 128 << 10,
  /** each persistent per-cell map */
  maps: 5000,
});

/** One action's budget (every counter is cumulative over the action). */
export const BUDGET = Object.freeze({
  /** the click's comparison of each listed cell's displayed text with its text version (UTF-16 code units; checked at the click, charged when the action begins) */
  clickUnits: 1 << 26,
  /** the commit's comparison of the displayed text with the captured text, and of the settings values (UTF-16 code units) */
  commitUnits: 1 << 26,
  /** sameRun: each sent cell's run against its checked spec (UTF-16 code units) */
  sendUnits: 1 << 26,
  /** run outputs compared again in a new epoch (UTF-16 code units; over it, a new output instead: notebook-reactive.ts runOutput) */
  rekeyUnits: 1 << 26,
  /** canonical eid input scanned for its exact length (UTF-8 bytes) */
  scanBytes: 1 << 26,
  /** canonical eid input built (UTF-8 bytes) */
  buildBytes: 1 << 26,
  eidHashes: 5000,
  sNodes: 10_000,
  vids: 5000,
  /** cells plus edges walked, over every snapshot and S walk */
  visits: 50_000_000,
});
export type BudgetKind = keyof typeof BUDGET;
const KINDS = Object.keys(BUDGET) as BudgetKind[];

// (no cells)
const NONE: ReadonlySet<string> = new Set();

/** The note for anything over a cap or a budget. */
export const TOO_LARGE = "too large for one remote action; run a smaller selection";

/** Over a cap or a budget: nothing more is built, hashed or sent. */
export class TooLarge extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`${TOO_LARGE} (${kind})`);
    this.kind = kind;
  }
}

/** An action's budget: what it may still use, and what it has used. */
export class Budget {
  readonly limits: Record<BudgetKind, number>;
  readonly used: Record<BudgetKind, number>;
  /**
   * What the tests count besides: the unique eid memo
   * entries and S v2 nodes this action was served that it didn't make
   * itself (each once, however often it is looked up again).
   */
  readonly counts = { memoHits: 0, nodeReuses: 0 };
  // (made in this action, or already counted)
  readonly made = new WeakSet<object>();
  readonly served = new WeakSet<object>();
  constructor(limits: Partial<Record<BudgetKind, number>> = BUDGET) {
    this.limits = { ...BUDGET, ...limits };
    this.used = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<BudgetKind, number>;
  }
  fits(kind: BudgetKind, n: number): boolean {
    return this.used[kind] + n <= this.limits[kind];
  }
  /** Use n of it, or (if that would go over) throw before anything is used. */
  charge(kind: BudgetKind, n: number): void {
    if (!this.fits(kind, n)) throw new TooLarge(kind);
    this.used[kind] += n;
  }
}
/** No limits (the module used directly, outside an action: tests). */
export const UNLIMITED: Readonly<Record<BudgetKind, number>> = Object.freeze(Object.fromEntries(KINDS.map((k) => [k, Infinity])) as Record<BudgetKind, number>);

/** The walks of one cell's closure in one submission: freeze (snapshot, S), check (snapshot, S, snapshot), admit (snapshot). */
export const WALKS_PER_SUBMISSION = 6;
/** The walks of a consent's listed cells after the precount (the earlier stages come before it): the claim and the commit. */
export const COMMIT_WALKS = 2;

/** sameRun's units for a spec: everything in it that runs, in UTF-16 code units (the precount plans exactly these). */
export function sendUnits(s: RunSpec): number {
  const o = s.options;
  let n = s.source.length + (o.seed?.length ?? 0) + s.mode.length + s.id.length + (o.mangle?.length ?? 0);
  for (const f of o.forget ?? []) n += f.length;
  if (o.scoped) for (const k of Object.keys(o.scoped)) n += k.length + o.scoped[k].length;
  return n;
}

/** A job's own run, as the scheduler asks for it now (what sameRun compares with the checked spec). */
export interface JobRun {
  code: string;
  mode: string;
  cell: string;
  seed: string | null;
  mangle: string | null;
  forget: readonly string[] | null;
  scoped: Readonly<Record<string, string>> | null;
}

/**
 * Test-only faults: an S v2 node reused whatever its key, or by comparing
 * its parents' digests as strings.  Never
 * set outside tests (a census test checks that).
 */
export interface ApprovalTestHooks {
  reuseAnyNode?: boolean;
  digestReuse?: boolean;
}
let testHooks: ApprovalTestHooks | null = null;
/** Tests only: set (or clear, with null) the faults above. */
export function setTestHooks(h: ApprovalTestHooks | null): void {
  testHooks = h;
}

// ---------------------------------------------------------------- consent

/** A cell's text version: a frozen object the page replaces whenever the cell's text changes. */
export interface TextVersion {
  readonly text: string;
}

/** What a person's gesture saw: read synchronously in its handler, before anything asynchronous. */
export interface ConsentInputs {
  /** each listed cell: the text displayed in its editor, and its text version */
  cells: ReadonlyMap<string, { readonly displayed: string; readonly version: TextVersion }>;
  /** a version whose text isn't what is displayed (a writer missed its replacement): the page makes a new one from the displayed text */
  repair(id: string, text: string): TextVersion;
  /** the page's settings object (mode, seed namespace, reactive flag): a frozen object, replaced whenever one of them changes */
  settings: object;
  mode: string;
  /** the notebook's seed (each cell's seed is derived from it and the cell's id) */
  seedNamespace: string;
  /** the reactive flag (the mangle option is derived from it and the cell's id) */
  reactive: boolean;
}

/** The page as it is now, for checking a consent. */
export interface ConsentEnv {
  /** the page's settings object now */
  settings(): object;
  /** a cell's text version now */
  version(id: string): TextVersion | undefined;
  /** the text version a cell's registration was made from */
  registered(id: string): object | undefined;
  /** a cell's text in the editor now (read live) */
  displayed(id: string): string | undefined;
  /** the settings' values, read from the page's own state (not from its settings object) */
  mode(): string;
  seedNamespace(): string;
  reactive(): boolean;
  /** whether the seed for (namespace, cell) has been prepared */
  seedReady(namespace: string, id: string): boolean;
}

/** A person's consent: a frozen, single-use capability (its state and what it captured are kept privately). */
export interface Consent {
  readonly ids: readonly string[];
  readonly approvalEpoch: number;
  readonly doc: string;
  readonly ctx: Readonly<KernelContext>;
  /** the page's settings object at the gesture (compared by identity), and its values */
  readonly settings: object;
  readonly mode: string;
  readonly seedNamespace: string;
  readonly reactive: boolean;
  /** the click's comparison (UTF-16 code units), charged to the action when it begins */
  readonly clickUnits: number;
}
type ConsentState = "issued" | "spent" | "void" | { readonly claimed: object };
/** A consent's stages before its approval: the action's start (before registration), after registration, after the seeds are prepared. */
export type ConsentStage = "beforeRegistration" | "registered" | "seeded";

// An S v2 node: immutable; reused only while its spec, its parents array and every parent's node are the same objects.
interface SNode {
  readonly spec: RunSpec | undefined;
  readonly parents: readonly string[];
  readonly parentNodes: readonly SNode[];
  readonly h: string;
}

const byId = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

export class Approvals {
  /** reset to a new epoch (approvals forgotten) by a load, a replace, a rebind, a takeover, a target or account change */
  approvalEpoch = 0;
  /** the document's identity: new on each load or replace */
  doc: string;
  /** the running action's budget (outside an action: no limits) */
  budget: Budget = new Budget(UNLIMITED);
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
  /** eids, by spec object (never written on the spec) */
  private memo = new WeakMap<RunSpec, { eidInputBytes: number; eid?: string; pending?: Promise<string> }>();
  /** each cell's current S v2 node */
  private nodes = new Map<string, SNode>();
  private consentState = new WeakMap<Consent, ConsentState>();
  /** what a consent captured: each listed cell's text version and text */
  private consentCells = new WeakMap<Consent, { versions: ReadonlyMap<string, TextVersion>; texts: ReadonlyMap<string, string> }>();
  /** what the controls count over every action: content comparisons made, and digests compared by value (none: nodes are reused by identity) */
  readonly stats = { compares: 0, digestCompares: 0 };
  /** specs whose options are known to be within their caps (each is frozen: checked once) */
  private capped = new WeakSet<RunSpec>();

  constructor(hash: Hash, graph: ApprovalGraph, context: () => KernelContext, newDoc?: () => string) {
    this.hash = hash;
    this.graph = graph;
    this.context = context;
    this.newDoc = newDoc ?? (() => Math.random().toString(36).slice(2) + Date.now().toString(36));
    this.doc = this.newDoc();
  }

  /** An action begins: a fresh budget (`limits`: the defaults). */
  beginAction(limits: Partial<Record<BudgetKind, number>> = BUDGET): Budget {
    return (this.budget = new Budget(limits));
  }
  /** The action ended: no budget until the next. */
  endAction(): void {
    this.budget = new Budget(UNLIMITED);
  }

  /** The action's run outputs may compare `units` more (notebook-reactive.ts runOutput): charged if they fit. */
  rekey(units: number): boolean {
    if (!this.budget.fits("rekeyUnits", units)) return false;
    this.budget.charge("rekeyUnits", units);
    return true;
  }

  // An eid memo entry or S node served to this action: counted once, unless the action made it.
  private served(o: object, k: "memoHits" | "nodeReuses"): void {
    const b = this.budget;
    if (b.made.has(o) || b.served.has(o)) return;
    b.served.add(o);
    b.counts[k]++;
  }

  // ------------------------------------------------------------- snapshots

  private ctxNow(): Readonly<KernelContext> {
    const c = this.context();
    return Object.freeze({ binding: c.binding, own: c.own, generation: c.generation, incarnation: c.incarnation, ready: c.ready });
  }

  // `ids` and their ancestors, now (synchronous), with the structural caps; the visits are counted.
  private snap(ids: readonly string[]): Snapshot {
    const cells = new Map<string, CellSnap>();
    let edges = 0, idBytes = 0;
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop()!;
      if (cells.has(id)) continue;
      if (cells.size >= CAPS.cells) throw new TooLarge("cells");
      const b = utf8Bytes(id);
      if (b > CAPS.idBytes) throw new TooLarge("cell id");
      if ((idBytes += b) > CAPS.idTotalBytes) throw new TooLarge("cell ids");
      const parents = this.graph.parents(id);
      if ((edges += parents.length) > CAPS.edges) throw new TooLarge("edges");
      const spec = this.graph.spec(id);
      if (spec) this.capOptions(spec);
      cells.set(id, Object.freeze({ spec, parents, record: this.records.get(id) }));
      for (const p of parents) if (!cells.has(p)) stack.push(p);
    }
    this.budget.charge("visits", cells.size + edges);
    return Object.freeze({
      ids: Object.freeze([...ids]), approvalEpoch: this.approvalEpoch, doc: this.doc, recordsGeneration: this.recordsGeneration,
      ctx: this.ctxNow(), cells, edges,
    });
  }

  // The same state: scalars, the kernel's fields, and per cell its spec and record by identity, and its
  // parents by identity (or, if the array was made again, by value: their ids, counted as visits).
  private same(a: Snapshot, b: Snapshot): boolean {
    if (a.approvalEpoch !== b.approvalEpoch || a.doc !== b.doc || a.recordsGeneration !== b.recordsGeneration) return false;
    for (const k of CTX_FIELDS) if (a.ctx[k] !== b.ctx[k]) return false;
    if (a.ids.length !== b.ids.length || a.ids.some((x, i) => x !== b.ids[i])) return false;
    if (a.cells.size !== b.cells.size) return false;
    for (const [id, x] of a.cells) {
      const y = b.cells.get(id);
      if (!y || y.spec !== x.spec || y.record !== x.record) return false;
      if (y.parents !== x.parents) {
        if (y.parents.length !== x.parents.length) return false;
        this.budget.charge("visits", x.parents.length);
        if (x.parents.some((p, i) => p !== y.parents[i])) return false;
      }
    }
    return true;
  }

  // A spec's forget list and scoped map within their caps (once per spec object: it is frozen).
  private capOptions(spec: RunSpec): void {
    if (this.capped.has(spec)) return;
    const o = spec.options;
    if (o.forget) {
      if (o.forget.length > CAPS.forgetNames) throw new TooLarge("forget");
      let n = 0;
      for (const f of o.forget) n += f.length;
      if (n > CAPS.forgetUnits) throw new TooLarge("forget");
    }
    if (o.scoped) {
      const keys = Object.keys(o.scoped);
      if (keys.length > CAPS.scopedEntries) throw new TooLarge("scoped");
      let n = 0;
      for (const k of keys) n += k.length + o.scoped[k].length;
      if (n > CAPS.scopedUnits) throw new TooLarge("scoped");
    }
    this.capped.add(spec);
  }

  // ------------------------------------------------------------- eids

  // The exact canonical length of a spec's eid input, counted (scanBytes) and capped.
  private scanLength(spec: RunSpec): number {
    const n = jcsBytes(eidValue(spec));
    this.budget.charge("scanBytes", n);
    if (n > CAPS.eidInputBytes) throw new TooLarge("cell size");
    return n;
  }

  // A spec's eid: from the memo, or built and hashed now (charged).  A spec the action's precount
  // didn't plan (it changed during the action) is planned here, alone, under the same budget.
  private eidOf(spec: RunSpec): Promise<string> {
    let m = this.memo.get(spec);
    if (!m) {
      const n = this.scanLength(spec);
      if (!this.budget.fits("buildBytes", n)) throw new TooLarge("buildBytes");
      if (!this.budget.fits("eidHashes", 1)) throw new TooLarge("eidHashes");
      m = { eidInputBytes: n };
      this.memo.set(spec, m);
    }
    if (m.eid !== undefined) {
      this.served(spec, "memoHits");
      return Promise.resolve(m.eid);
    }
    if (m.pending) return m.pending;
    this.budget.charge("buildBytes", m.eidInputBytes);
    this.budget.charge("eidHashes", 1);
    this.budget.made.add(spec);
    const entry = m;
    const p = this.hash(jcs(eidValue(spec))).then(
      (h) => ((entry.eid = h), (entry.pending = undefined), h),
      (e) => {
        entry.pending = undefined;
        throw e;
      },
    );
    entry.pending = p;
    return p;
  }

  /** A cell's eid now (undefined if it isn't runnable or the page isn't bound). */
  async eid(id: string): Promise<string | undefined> {
    const s = this.graph.spec(id);
    return s ? this.eidOf(s) : undefined;
  }

  /** What the memo holds for a spec (tests: the three phases): nothing, its staged length, or its eid. */
  memoState(spec: RunSpec): "none" | "length" | "eid" {
    const m = this.memo.get(spec);
    return !m ? "none" : m.eid === undefined ? "length" : "eid";
  }

  isApproved(eid: string | undefined): boolean {
    return eid !== undefined && this.approved.has(eid);
  }

  // ------------------------------------------------------------- the precount

  /**
   * Plan an action before anything is built, hashed or sent: the cells it
   * may send (`order`) and their ancestors, in one pass.  It stages each
   * new spec's exact canonical length (the scan is charged), and counts the
   * eid, S and vid hashes and the snapshot visits the action would need.
   * If all fit in the budget, the staged lengths go into the memo; if not,
   * nothing is kept, and the action is refused.  `listed`: the cells a
   * consent in this action approves (their checks are walked twice).
   */
  precount(order: readonly string[], listed: readonly string[] = []): { ok: boolean; reason?: string; planned?: Partial<Record<BudgetKind, number>> } {
    const b = this.budget;
    const staged = new Map<RunSpec, number>();
    let planned: Partial<Record<BudgetKind, number>> | undefined;
    try {
      // the union closure, in topological order (parents first), with each cell's parents
      const topo: string[] = [];
      const parentsOf = new Map<string, readonly string[]>();
      const state = new Map<string, 1 | 2>(); // 1: on the stack, 2: done
      let edges = 0;
      for (const root of order) {
        if (state.has(root)) continue;
        const stack: [string, number][] = [[root, 0]];
        state.set(root, 1);
        parentsOf.set(root, this.graph.parents(root));
        while (stack.length) {
          const top = stack[stack.length - 1];
          const ps = parentsOf.get(top[0])!;
          if (top[1] < ps.length) {
            const p = ps[top[1]++];
            edges++;
            if (!state.has(p)) {
              state.set(p, 1);
              parentsOf.set(p, this.graph.parents(p));
              stack.push([p, 0]);
            } // (a cycle's back edge is not followed; a cycle is refused when checked)
          } else {
            stack.pop();
            state.set(top[0], 2);
            topo.push(top[0]);
          }
        }
      }
      b.charge("visits", topo.length + edges);
      // eids to build and hash: each spec without a memo entry is scanned (exact length), staged
      let build = 0, eids = 0;
      for (const id of topo) {
        const spec = this.graph.spec(id);
        if (!spec) continue;
        this.capOptions(spec);
        const m = this.memo.get(spec);
        if (m?.eid !== undefined) continue;
        let n = m?.eidInputBytes ?? staged.get(spec);
        if (n === undefined) {
          n = this.scanLength(spec);
          staged.set(spec, n);
        }
        build += n;
        eids++;
      }
      // S v2 nodes that would be new: a node is reused only if its spec, parents and parents' nodes are
      const reusable = new Map<string, boolean>();
      let sNodes = 0;
      for (const id of topo) {
        const old = this.nodes.get(id);
        const ps = parentsOf.get(id)!;
        const ok = !!old && old.spec === this.graph.spec(id) && old.parents === ps && old.parentNodes.length === ps.length &&
          ps.every((p, i) => reusable.get(p) === true && old.parentNodes[i] === this.nodes.get(p));
        reusable.set(id, ok);
        if (!ok) sNodes++;
      }
      // visits: each sent cell's closure (cells c, edges e) bounded in one pass, saturating
      const cap = b.limits.visits + 1;
      const cb = new Map<string, number>(), eb = new Map<string, number>();
      for (const id of topo) {
        const ps = parentsOf.get(id)!;
        let c = 1, e = ps.length;
        for (const p of ps) {
          c = Math.min(cap, c + (cb.get(p) ?? 0));
          e = Math.min(cap, e + (eb.get(p) ?? 0));
        }
        cb.set(id, c);
        eb.set(id, e);
      }
      let visits = COMMIT_WALKS * listed.length;
      for (const id of order) visits = Math.min(cap, visits + WALKS_PER_SUBMISSION * ((cb.get(id) ?? 1) + (eb.get(id) ?? 0)));
      // sameRun, once per cell it may send
      let send = 0;
      for (const id of order) {
        const spec = this.graph.spec(id);
        if (spec) send += sendUnits(spec);
      }
      planned = { sendUnits: send, buildBytes: build, eidHashes: eids, sNodes, vids: order.length, visits };
      for (const k of Object.keys(planned) as BudgetKind[]) if (!b.fits(k, planned[k]!)) return { ok: false, reason: TOO_LARGE, planned };
    } catch (e) {
      if (e instanceof TooLarge) return { ok: false, reason: TOO_LARGE, planned };
      throw e;
    }
    // (all of it fits: only now are the lengths kept)
    for (const [spec, n] of staged) if (!this.memo.has(spec)) this.memo.set(spec, { eidInputBytes: n });
    return { ok: true, planned };
  }

  // ------------------------------------------------------------- consent

  /**
   * A person's consent to run these cells as they are on screen: called
   * synchronously in the gesture's handler, before anything asynchronous.
   * Each listed cell's displayed text is compared once with its text
   * version (the lengths summed first: over clickUnits, nothing is compared
   * and the consent is void); a version that differs is replaced from the
   * displayed text, so what is approved is what was shown.  Single use;
   * approveCells is the only thing that can spend it.
   */
  captureConsent(ids: readonly string[], inputs: ConsentInputs): Consent {
    let units = 0, missing = false;
    for (const id of ids) {
      const c = inputs.cells.get(id);
      if (!c) missing = true;
      else if (c.displayed.length === c.version.text.length) units += c.displayed.length;
    }
    const over = units > BUDGET.clickUnits;
    const versions = new Map<string, TextVersion>(), texts = new Map<string, string>();
    if (!over && !missing) {
      for (const id of ids) {
        const c = inputs.cells.get(id)!;
        let v = c.version;
        let same = c.displayed.length === v.text.length;
        if (same) {
          this.stats.compares++;
          same = c.displayed === v.text;
        }
        if (!same) v = inputs.repair(id, c.displayed);
        versions.set(id, v);
        texts.set(id, c.displayed);
      }
    }
    const cap: Consent = Object.freeze({
      ids: Object.freeze([...ids]), approvalEpoch: this.approvalEpoch, doc: this.doc, ctx: this.ctxNow(),
      settings: inputs.settings, mode: inputs.mode, seedNamespace: inputs.seedNamespace, reactive: inputs.reactive,
      clickUnits: over ? 0 : units,
    });
    this.consentCells.set(cap, { versions, texts });
    this.consentState.set(cap, over || missing ? "void" : "issued");
    return cap;
  }

  /** The action a consent belongs to was refused (too large): an issued consent is void (any other is left as it is). */
  voidConsent(cap: Consent): void {
    if (this.consentState.get(cap) === "issued") this.consentState.set(cap, "void");
  }

  /** A consent's state, for display and tests: issued, claimed, spent, void (or unknown: not one of ours). */
  consentStateOf(cap: Consent): "issued" | "claimed" | "spent" | "void" | "unknown" {
    const s = this.consentState.get(cap);
    return s === undefined ? "unknown" : typeof s === "object" ? "claimed" : s;
  }

  // The checks of every stage, by identity (O(1) per listed cell, counted as visits): the scope (the
  // approval epoch, the document, the kernel's fields, the settings object), each listed cell's text
  // version; after registration (`registered`), the version its registration was made from; once the
  // seeds are prepared (`seeds`), each cell's seed from the captured namespace.
  private consentOk(cap: Consent, env: ConsentEnv, registered: boolean, seeds: boolean): boolean {
    if (cap.approvalEpoch !== this.approvalEpoch || cap.doc !== this.doc) return false;
    const now = this.context();
    for (const k of CTX_FIELDS) if (cap.ctx[k] !== now[k]) return false;
    if (env.settings() !== cap.settings) return false;
    const { versions } = this.consentCells.get(cap)!;
    this.budget.charge("visits", cap.ids.length);
    for (const id of cap.ids) {
      const v = versions.get(id);
      if (!v || env.version(id) !== v) return false;
      if (registered && env.registered(id) !== v) return false;
      if (seeds && !env.seedReady(cap.seedNamespace, id)) return false;
    }
    return true;
  }

  // The commit's comparison, by value: each listed cell's displayed text (read live) with the text
  // captured, and the settings' values with those captured.  The lengths first: any that differs is a
  // difference, compared with nothing; the units summed (commitUnits) and, over it, nothing compared.
  private committedOk(cap: Consent, env: ConsentEnv): boolean {
    const { texts } = this.consentCells.get(cap)!;
    const shown: string[] = [];
    let units = cap.mode.length + cap.seedNamespace.length + 1;
    for (const id of cap.ids) {
      const d = env.displayed(id), t = texts.get(id)!;
      if (d === undefined || d.length !== t.length) return false;
      shown.push(d);
      units += t.length;
    }
    const mode = env.mode(), ns = env.seedNamespace();
    if (mode.length !== cap.mode.length || ns.length !== cap.seedNamespace.length) return false;
    if (!this.budget.fits("commitUnits", units)) return false;
    this.budget.charge("commitUnits", units);
    for (let i = 0; i < cap.ids.length; i++) {
      this.stats.compares++;
      if (shown[i] !== texts.get(cap.ids[i])) return false;
    }
    this.stats.compares++;
    return mode === cap.mode && ns === cap.seedNamespace && env.reactive() === cap.reactive;
  }

  /**
   * A stage of a consent's checks before its approval: "beforeRegistration"
   * at the serial step's start (the click's units are charged to the action
   * here), "registered" after registration, "seeded" after the seeds are
   * prepared (one await, every listed cell's).  Only an issued consent passes; a
   * consent in any other state is refused untouched (another call owns it,
   * or it is spent or void), and an issued one that fails is void.
   */
  consentStage(cap: Consent, stage: ConsentStage, env: ConsentEnv): boolean {
    if (this.consentState.get(cap) !== "issued") return false;
    let ok = false;
    try {
      if (stage === "beforeRegistration") {
        if (!this.budget.fits("clickUnits", cap.clickUnits)) return false;
        this.budget.charge("clickUnits", cap.clickUnits);
      }
      ok = this.consentOk(cap, env, stage !== "beforeRegistration", stage === "seeded");
    } finally {
      if (!ok) this.consentState.set(cap, "void");
    }
    return ok;
  }

  /**
   * Approve exactly a consent's cells (the claim, then the commit): synchronously at the
   * start, every check (all seeds prepared) and then the claim; at the
   * commit, the claim still this call's, every check again, the cells'
   * specs the ones hashed, and the displayed text and the settings, by
   * value, those captured.  All of them, or none (the consent is then
   * void).  A call that finds the consent claimed, spent or void, or that
   * lists other cells, is refused without touching it.
   */
  async approveCells(ids: readonly string[], { expected, env }: { expected: Consent; env: ConsentEnv }): Promise<boolean> {
    if (this.consentState.get(expected) !== "issued") return false;
    if (ids.length !== expected.ids.length || ids.some((id, i) => id !== expected.ids[i])) return false;
    const call = {};
    const owned = () => {
      const s = this.consentState.get(expected);
      return typeof s === "object" && s.claimed === call;
    };
    try {
      // the claim
      if (!this.consentOk(expected, env, true, true)) {
        this.consentState.set(expected, "void");
        return false;
      }
      this.consentState.set(expected, { claimed: call });
      const specs = ids.map((id) => this.graph.spec(id));
      if (specs.some((s) => !s)) {
        this.consentState.set(expected, "void");
        return false;
      }
      const eids: string[] = [];
      for (const s of specs) eids.push(await this.eidOf(s!));
      // the commit (the claim replaces the issued check)
      if (!owned()) return false;
      if (!this.consentOk(expected, env, true, true) || ids.some((id, i) => this.graph.spec(id) !== specs[i]) || !this.committedOk(expected, env)) {
        this.consentState.set(expected, "void");
        return false;
      }
      this.consentState.set(expected, "spent");
      for (const e of eids) this.approved.add(e);
      return true;
    } catch (e) {
      if (owned() || this.consentState.get(expected) === "issued") this.consentState.set(expected, "void");
      throw e;
    }
  }

  /**
   * The job's own run (what the scheduler asks for now: notebook-reactive.ts
   * runSpec, the page's mode, seed and reactive flag) is the checked spec,
   * by value: compared once, right before it is admitted.  The lengths
   * first (any that differs is a difference, compared with nothing), then
   * the units (sendUnits; the precount planned them) charged, and only if
   * they fit, compared.
   */
  sameRun(run: JobRun, spec: RunSpec): boolean {
    const o = spec.options;
    const forget = run.forget && run.forget.length ? run.forget : null;
    const scoped = run.scoped && Object.keys(run.scoped).length ? run.scoped : null;
    if (run.code.length !== spec.source.length || run.mode.length !== spec.mode.length || run.cell.length !== spec.id.length) return false;
    if ((run.seed === null) !== (o.seed === null) || (run.seed ?? "").length !== (o.seed ?? "").length) return false;
    if ((run.mangle === null) !== (o.mangle === null) || (run.mangle ?? "").length !== (o.mangle ?? "").length) return false;
    if ((forget === null) !== (o.forget === null) || (forget && (forget.length !== o.forget!.length || forget.some((f, i) => f.length !== o.forget![i].length)))) return false;
    if ((scoped === null) !== (o.scoped === null)) return false;
    if (scoped && o.scoped) {
      const keys = Object.keys(o.scoped);
      if (Object.keys(scoped).length !== keys.length) return false;
      for (const k of keys) if (!has(scoped, k) || scoped[k].length !== o.scoped[k].length) return false;
    }
    const units = sendUnits(spec);
    if (!this.budget.fits("sendUnits", units)) return false;
    this.budget.charge("sendUnits", units);
    this.stats.compares++;
    if (run.code !== spec.source || run.mode !== spec.mode || run.cell !== spec.id || run.seed !== o.seed || run.mangle !== o.mangle) return false;
    if (forget && forget.some((f, i) => f !== o.forget![i])) return false;
    if (scoped && o.scoped) for (const k of Object.keys(o.scoped)) if (scoped[k] !== o.scoped[k]) return false;
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
  /**
   * A cell's names were deleted in the kernel (called right before that is
   * sent): its record goes, and so does any pending attempt's (a fresh
   * latest number no admitted job holds).
   */
  forgotten(cells: Iterable<string>): void {
    for (const id of cells) {
      this.records.delete(id);
      if (this.latest.has(id)) this.latest.set(id, ++this.attempts);
    }
  }
  /** Drop what is kept for cells no longer in the notebook (on every registration). */
  prune(present: (id: string) => boolean): void {
    for (const m of [this.records, this.latest, this.settled, this.nodes] as Map<string, unknown>[]) {
      for (const id of [...m.keys()]) if (!present(id)) m.delete(id);
    }
  }
  /** Sizes of the persistent maps (tests: their bounds). */
  sizes(): { records: number; latest: number; settled: number; nodes: number } {
    return { records: this.records.size, latest: this.latest.size, settled: this.settled.size, nodes: this.nodes.size };
  }

  /** The record a cell's last successful run left, if any. */
  record(id: string): SuccessRecord | undefined {
    return this.records.get(id);
  }

  // ------------------------------------------------------------- S v2

  // The witness of a snapshot's submitted cells: per cell h(c) over its id, eid and parents' h, each
  // node reused while its spec, parents and parents' nodes are the same objects.  null: a cycle.
  private async witnessIn(s: Snapshot): Promise<string | null> {
    this.budget.charge("visits", s.cells.size + s.edges);
    // topological order (parents first) by DFS, detecting a cycle
    const topo: string[] = [];
    const state = new Map<string, 1 | 2>();
    for (const root of s.ids) {
      if (state.has(root)) continue;
      const stack: [string, number][] = [[root, 0]];
      state.set(root, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const ps = s.cells.get(top[0])!.parents;
        if (top[1] < ps.length) {
          const p = ps[top[1]++];
          const st = state.get(p);
          if (st === 1) return null;
          if (st === undefined) {
            state.set(p, 1);
            stack.push([p, 0]);
          }
        } else {
          stack.pop();
          state.set(top[0], 2);
          topo.push(top[0]);
        }
      }
    }
    const cur = new Map<string, SNode>();
    for (const id of topo) {
      const c = s.cells.get(id)!;
      const pn = c.parents.map((p) => cur.get(p)!);
      const old = this.nodes.get(id);
      let node = old && (testHooks?.reuseAnyNode || (old.spec === c.spec && old.parents === c.parents && this.sameNodes(old.parentNodes, pn))) ? old : undefined;
      if (node) this.served(node, "nodeReuses");
      else {
        const eid = c.spec ? await this.eidOf(c.spec) : null;
        const input = ["S", 2, id, eid, c.parents.map((p, i) => [p, pn[i].h])];
        if (jcsBytes(input) > CAPS.sNodeInputBytes) throw new TooLarge("node");
        this.budget.charge("sNodes", 1);
        node = Object.freeze({ spec: c.spec, parents: c.parents, parentNodes: Object.freeze(pn), h: await this.hash(jcs(input)) });
        this.budget.made.add(node);
        if (this.nodes.has(id) || this.nodes.size < CAPS.maps) this.nodes.set(id, node);
      }
      cur.set(id, node);
    }
    if (s.ids.length === 1) return cur.get(s.ids[0])!.h;
    this.budget.charge("sNodes", 1);
    return this.hash(jcs(["S", 2, "batch", s.ids.map((id) => [id, cur.get(id)!.h])]));
  }

  // A node's parents' nodes, the same objects (by identity: no digest is compared, unless a test plants that).
  private sameNodes(old: readonly SNode[], now: readonly SNode[]): boolean {
    if (old.length !== now.length) return false;
    if (testHooks?.digestReuse) {
      return old.every((x, i) => {
        this.stats.digestCompares++;
        return x.h === now[i].h;
      });
    }
    return old.every((x, i) => x === now[i]);
  }

  // ------------------------------------------------------------- the submit check

  /** Freeze a cell, or a batch (in its order), as it is queued: computed entirely on one snapshot. */
  async freeze(ids: string[]): Promise<Frozen> {
    const s = this.snap(ids);
    const witness = await this.witnessIn(s);
    const eids: string[] = [];
    for (const id of ids) {
      const spec = s.cells.get(id)!.spec;
      eids.push(spec ? await this.eidOf(spec) : "");
    }
    return { cells: [...ids], eids, approvalEpoch: s.approvalEpoch, doc: s.doc, binding: s.ctx.binding, own: s.ctx.own, generation: s.ctx.generation, witness };
  }

  // Provenance validity in a snapshot (the plan's §3.2): a record in its
  // binding and incarnation, for the cell's eid there, approved, with the
  // parents it has there, each of them valid with the vid the record names.
  // (`gone`: cells whose records are taken as absent: a wave's initial forget, about to delete their names)
  private validIn(s: Snapshot, eids: Map<string, string | undefined>, gone: ReadonlySet<string> = NONE): (id: string) => boolean {
    const memo = new Map<string, boolean>();
    const valid = (id: string): boolean => {
      const m = memo.get(id);
      if (m !== undefined) return m;
      memo.set(id, false); // (a cycle is never valid)
      const c = s.cells.get(id);
      const r = gone.has(id) ? undefined : c?.record;
      const e = eids.get(id);
      let ok = !!c && !!r && r.xi.binding === s.ctx.binding && r.xi.incarnation === s.ctx.incarnation && r.eid === e && this.isApproved(e);
      if (ok) ok = sameSet(c!.parents, r!.pi.map(([p]) => p)) && r!.pi.every(([p, v]) => valid(p) && !gone.has(p) && s.cells.get(p)?.record?.vid === v);
      memo.set(id, ok);
      return ok;
    };
    return valid;
  }

  /**
   * The submit check, computed on one snapshot.  `request`: the run's
   * request id (one per submission; a batch's cells are its batch indexes).
   * Whatever it finds, if anything it was computed on changed meanwhile the
   * verdict is stale: skip (never send, nor wait).  A send verdict is then
   * admitted (admit) synchronously right before the fetch that sends it.
   */
  async check(frozen: Frozen, request: string, opts: { forgotten?: Iterable<string> } = {}): Promise<Verdict> {
    // (a wave's initial forget: the cells whose names it deletes first, their records taken as absent; nothing is changed)
    const gone: ReadonlySet<string> = opts.forgotten ? new Set(opts.forgotten) : NONE;
    let s: Snapshot;
    try {
      s = this.snap(frozen.cells);
    } catch (e) {
      if (e instanceof TooLarge) return { send: false, skip: TOO_LARGE };
      throw e;
    }
    let v: { send: true; plan: Planned[] } | { send: false; wait: string } | { send: false; skip: string };
    try {
      v = await this.verdictIn(s, frozen, request, gone);
    } catch (e) {
      if (e instanceof TooLarge) return { send: false, skip: TOO_LARGE };
      throw e;
    }
    // (stale takes precedence over every verdict reached after an await)
    let now: Snapshot;
    try {
      now = this.snap(frozen.cells);
    } catch (e) {
      if (e instanceof TooLarge) return { send: false, skip: TOO_LARGE };
      throw e;
    }
    if (!this.same(s, now)) return { send: false, skip: "something changed while it was being checked" };
    return v.send ? { send: true, plan: v.plan, token: { cells: [...frozen.cells], snapshot: s, consumed: false } } : v;
  }

  // The submit check's verdict on a snapshot (a send verdict without its token: check() adds it).
  private async verdictIn(s: Snapshot, frozen: Frozen, request: string, gone: ReadonlySet<string> = NONE): Promise<{ send: true; plan: Planned[] } | { send: false; wait: string } | { send: false; skip: string }> {
    // 1. the approvals and the document it was queued under
    if (s.approvalEpoch !== frozen.approvalEpoch || s.doc !== frozen.doc) return { send: false, skip: "approvals were reset or the notebook was replaced" };
    // 5. the kernel it was queued for, still bound and ready
    const ctx = s.ctx;
    if (!ctx.ready || ctx.binding === null || ctx.binding !== frozen.binding || ctx.own !== frozen.own || ctx.generation !== frozen.generation) {
      return { send: false, skip: "the kernel changed" };
    }
    const binding: string = ctx.binding;
    // 3. the structure of its closure, unchanged (this also computes every eid in it)
    const witness = await this.witnessIn(s);
    if (witness === null) return { send: false, skip: "its cells depend on each other in a cycle" };
    const eids = new Map<string, string | undefined>();
    for (const [id, c] of s.cells) eids.set(id, c.spec ? await this.eidOf(c.spec) : undefined);
    // 2. its own code, unchanged and approved (approvals are only ever removed by a reset, which 1 catches)
    for (let i = 0; i < frozen.cells.length; i++) {
      const e = eids.get(frozen.cells[i]);
      if (e === undefined || e !== frozen.eids[i] || !this.isApproved(e)) return { send: false, skip: "the cell changed, or is not approved" };
    }
    if (witness !== frozen.witness) return { send: false, skip: "a cell it depends on changed" };
    // 4. every ancestor outside the submission provenance-valid; inside it, earlier in batch order
    const inBatch = new Map(frozen.cells.map((id, i) => [id, i]));
    for (let i = 0; i < frozen.cells.length; i++) {
      for (const p of s.cells.get(frozen.cells[i])!.parents) {
        const j = inBatch.get(p);
        if (j !== undefined && j >= i) return { send: false, skip: "the batch is not in dependency order" };
      }
    }
    const valid = this.validIn(s, eids, gone);
    for (const a of [...s.cells.keys()].filter((id) => !inBatch.has(id)).sort()) {
      if (!valid(a)) return { send: false, wait: `an ancestor has to run first (${a})` };
    }
    // the plan: each cell's identity, its parents' vids as they will be when it runs (a parent earlier
    // in the batch contributes the vid it will have if it succeeds), and its own vid
    const planned = new Map<string, string>();
    const plan: Planned[] = [];
    for (let i = 0; i < frozen.cells.length; i++) {
      const cell = frozen.cells[i];
      const c = s.cells.get(cell)!;
      const xi: ExecutionIdentity = { binding, incarnation: ctx.incarnation, request, cell, batch: i };
      const pi = c.parents.map((p) => [p, planned.get(p) ?? (gone.has(p) ? "" : s.cells.get(p)!.record!.vid)] as [string, string]).sort(byId);
      const eid = eids.get(cell)!;
      this.budget.charge("vids", 1);
      const vid = await this.hash(jcs(["vid", 2, xi, eid, pi]));
      planned.set(cell, vid);
      plan.push({ cell, eid, run: c.spec!, xi, pi, vid, attempt: 0, recordsGeneration: s.recordsGeneration, approvalEpoch: s.approvalEpoch, doc: s.doc });
    }
    return { send: true, plan };
  }

  /**
   * Consume a send verdict, synchronously, right before the fetch that
   * sends it: true (send it now) only if this is the token's first use and
   * nothing it was computed on has changed since.  Numbers each planned
   * cell's attempt, and drops the planned cells' records: while a cell runs
   * again, what was computed from its previous run is not valid.
   */
  admit(v: Verdict): boolean {
    if (!v.send || v.token.consumed) return false;
    let now: Snapshot;
    try {
      now = this.snap(v.token.cells);
    } catch (e) {
      if (e instanceof TooLarge) return false;
      throw e;
    }
    if (!this.same(v.token.snapshot, now)) return false;
    // (the fence needs room: a cell's latest attempt must be kept)
    const fresh = v.plan.filter((p) => !this.latest.has(p.cell)).length;
    if (this.latest.size + fresh > CAPS.maps) return false;
    v.token.consumed = true;
    for (const p of v.plan) {
      p.attempt = ++this.attempts;
      this.latest.set(p.cell, p.attempt);
      this.records.delete(p.cell);
    }
    // (the state right after admission: the same, without the planned cells' records)
    const cells = new Map(now.cells);
    for (const p of v.plan) {
      const c = cells.get(p.cell)!;
      cells.set(p.cell, Object.freeze({ spec: c.spec, parents: c.parents, record: undefined }));
    }
    v.token.admittedSnapshot = Object.freeze({ ...now, cells });
    return true;
  }

  /**
   * A wave's admission, the one transition (waves design r3, §3.6), synchronously right before the fetch that
   * sends it, all or nothing:
   *   (a) refused, with nothing changed, unless it is a send verdict whose token is unconsumed, nothing it was
   *       checked on changed (the state before any invalidation: what check saw), and the latest map has room;
   *   (b) the initial forget's cells (`forgetCells`): their records go, and a pending attempt of theirs is fenced
   *       (a fresh latest number no admitted job holds), as forgotten() does;
   *   (c) THEN this batch's attempts are numbered, each planned cell's latest is its attempt and its record goes
   *       (a cell in both ends with this batch's attempt);
   *   (d) the token is consumed, and the state after (b) and (c) captured: what a retry must still find.
   * Nothing calls forgotten() after it: stillAdmitted holds, and the batch's terminals apply, until something
   * outside changes (a delete, a reset, clearRecords, a restart, a later forgotten()).
   */
  admitWave(v: Verdict, forgetCells: Iterable<string>): boolean {
    if (!v.send || v.token.consumed) return false;
    let now: Snapshot;
    try {
      now = this.snap(v.token.cells);
    } catch (e) {
      if (e instanceof TooLarge) return false;
      throw e;
    }
    if (!this.same(v.token.snapshot, now)) return false;
    const fresh = v.plan.filter((p) => !this.latest.has(p.cell)).length;
    if (this.latest.size + fresh > CAPS.maps) return false;
    // (everything that can fail is built first: the admitted snapshot, the post-state, from the snapshot just
    // compared; the commit below only sets and deletes map entries)
    const forget = [...forgetCells];
    const cells = new Map(now.cells);
    for (const id of [...forget, ...v.plan.map((p) => p.cell)]) {
      const c = cells.get(id);
      if (c) cells.set(id, Object.freeze({ spec: c.spec, parents: c.parents, record: undefined }));
    }
    const admitted = Object.freeze({ ...now, cells });
    for (const id of forget) {
      this.records.delete(id);
      if (this.latest.has(id)) this.latest.set(id, ++this.attempts);
    }
    v.token.consumed = true;
    for (const p of v.plan) {
      p.attempt = ++this.attempts;
      this.latest.set(p.cell, p.attempt);
      this.records.delete(p.cell);
    }
    v.token.admittedSnapshot = admitted;
    return true;
  }

  /**
   * Whether a wave of these cells may be formed, with no effect at all (nothing hashed, built or charged; the
   * budget only read): each has a spec whose eid is already known and approved, and their sendUnits together fit
   * in what is left of the action's budget.  If not, the action runs cell by cell (where a cell that isn't
   * approved is left stale on its own, rather than refusing the whole wave).
   */
  predictSendable(ids: readonly string[]): boolean {
    let units = 0;
    for (const id of ids) {
      const spec = this.graph.spec(id);
      const eid = spec ? this.memo.get(spec)?.eid : undefined;
      if (eid === undefined || !this.approved.has(eid)) return false;
      units += sendUnits(spec!);
    }
    return this.budget.fits("sendUnits", units);
  }

  /**
   * For a retry of an admitted send (a nonce challenge's, or the identical
   * resend of one whose answer was lost), synchronously right before its
   * fetch: true only if the same attempt still stands (each cell's latest,
   * not settled, in its records' generation, approval epoch and document)
   * and nothing changed since it was admitted.  Never admits again.
   */
  stillAdmitted(v: Verdict): boolean {
    if (!v.send || !v.token.consumed || !v.token.admittedSnapshot) return false;
    for (const p of v.plan) {
      if (this.latest.get(p.cell) !== p.attempt || this.settled.get(p.cell) === p.attempt) return false;
      if (p.recordsGeneration !== this.recordsGeneration || p.approvalEpoch !== this.approvalEpoch || p.doc !== this.doc) return false;
    }
    try {
      return this.same(v.token.admittedSnapshot, this.snap(v.token.cells));
    } catch (e) {
      if (e instanceof TooLarge) return false;
      throw e;
    }
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
    if (!this.records.has(p.cell) && this.records.size >= CAPS.maps) return false;
    this.records.set(p.cell, Object.freeze({ eid: p.eid, xi: Object.freeze({ ...p.xi }), pi: Object.freeze(p.pi.map(([a, b]) => Object.freeze([a, b] as const))), vid: p.vid, attempt: p.attempt }));
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
