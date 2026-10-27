// The hub of `sagebrush board open --edit` (plan-board-open-edit r7 §2, §4,
// §5, §6): the one place a board's versions are merged, in the CLI process.
// No HTTP here (src/board-open.ts serves it), and no timers of its own: the
// clock is passed in and `tick()` is called, so the tests are deterministic.
//
// - P, the board's latest save: an immutable (value, seq, hash); P₀ is FILE as
//   found.  O, the hash last observed at FILE.  H, the merged head, with its seq.
// - An outside version C (a change seen at FILE, or bytes a save found there)
//   is merged against P: H := boardMerge3(P, H, C) (§4.2).  Fields where C
//   differs from P and equals one of the last SAVES_KEPT saves are flagged
//   "may be from an older copy" (§4.3): reported only, never undone.
// - A tab's submission is its snapshot S (whole, as records: patchflow's
//   records codec can't tell a field removed from one set to null in a patch)
//   made from the head it last adopted (baseSeq): H := boardMerge3(base, H, S).
//   Accepted ops are kept per tab (ACKS_KEPT), above a watermark; a released
//   tab leaves a tombstone of its watermark (TAB_TOMBSTONES) (§6.2).
// - Saving: one write at a time, at least WRITE_MIN_MS apart, of a frozen
//   tuple (§5.1, src/board-edit-write.ts); only its own completion advances P,
//   persistedSeq and each tab's persistedGen.
import { createHash } from "crypto";
import { dirname } from "path";
import { boardMerge3, keyOf, canon, ABSENT, type Rec, type MergeReport, type MergeAlternative } from "../web/board/merge";
import { editRecords, fromEditRecords, roundTrips, givePageIds, serialize, bytesAre, recordsAre } from "../web/board/lossless";
import { writeOnce, Slots, hashOf, realFs, type WriteFs, type WriteOutcome } from "./board-edit-write";
import type { Limits } from "./board-edit-limits";
import { Ledger, Reservation, submitCharge, keptCharge } from "./board-edit-memory";

/** A version the hub keeps; `charge` its Rv on the ledger (src/board-edit-memory.ts). */
export interface Version { seq: number; records: Rec[]; json: any; bytes: Buffer; hash: string; charge: number }
export type HubReport =
  | MergeReport
  /** §4.3: C's value (ABSENT: absent) equals a retained save's where that save differed from P; no `field`: the whole record */
  | { kind: "older-copy"; key: string; field?: string; value: unknown; board: unknown }
  /** §4.3: an outside change as merged into the head, `was` the board's value before it (ABSENT: absent); no
   * `field`: the whole record added or removed.  Its restore is the alternative with the same key (and field). */
  | { kind: "outside"; key: string; field?: string; was: unknown; now: unknown }
  | { kind: "prev-kept"; path: string; why: string };
/** A head's reports and their one-click alternatives, bound to its seq; `omitted`: how many past CONFLICTS_MAX weren't kept */
export interface HeadEvent { seq: number; persistedSeq: number; writtenSeq?: number; reports: HubReport[]; alternatives: MergeAlternative[]; source: "outside" | "tab" | "save"; omitted?: number }
/** A save's outcome: one write's (§5.2), or only the directory fsync a failed one left, retried and done. */
export type SaveOutcome = WriteOutcome | { saved: true; resynced: true; prev?: undefined; durable?: false };
export type SubmitAnswer =
  | { op: string; accepted: true; seq: number }
  | { op: string; included: number; seq: number }
  | { op: string; unknownTab: true }
  | { op: string; mismatch: true }
  | { op: string; stale: true; seq: number }
  | { op: string; refused: string }
  | { op: string; busy: string };
export type HubState =
  | { state: "ok" }
  | { state: "held"; why: "invalid" | "deleted" | "unmergeable" | "not-editable" | "slots" | "stuck" | "error"; detail: string };

/** A merged head made, ready to install. */
interface Made { json: any; bytes: Buffer; hash: string; charge: number }

interface Budget { used: number; deadline: number; charge: (n: number) => boolean; left: () => number; why: () => "work" | "time" }

interface TabRecord { watermark: number; acks: { gen: number; seq: number; hash: string }[]; lastSeen: number; pin?: number }

export interface HubDeps {
  now: () => number;
  fs?: WriteFs;
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const lines = (rs: Rec[]) => rs.map((r) => JSON.stringify(r)).join("\n");
/** An exception as a short reason (a RangeError from a value nested too deeply, say). */
const failure = (e: unknown) => (e instanceof RangeError ? "nested too deeply" : String((e as any)?.message ?? e).slice(0, 200));

export class EditHub {
  P!: Version;
  H!: Version;
  O = "";
  persistedSeq = 0;
  /** the latest seq whose bytes are at FILE through a completed write, durable or not: persistedSeq where every
   * write is confirmed durable; ahead of it where the directory can't be synced (Windows) */
  writtenSeq = 0;
  private seq = 0;
  private saves: Version[] = [];
  private heads = new Map<number, Version>();
  private tabs = new Map<string, TabRecord>();
  private tombstones = new Map<string, number>();
  private includedGens = new Map<string, number>(); // (per tab, the highest gen whose op is in H)
  /** per tab, the highest gen of its ops in a completed (durable) save: kept across a tombstone, as includedGens is */
  private persistedGens = new Map<string, number>();
  /** per tab, the highest gen of its ops in a completed write, durable or not (persistedGens' counterpart) */
  private writtenGens = new Map<string, number>();
  readonly slots: Slots;
  state: HubState = { state: "ok" };
  /** whether the hold in `state` is FILE's own (invalid, deleted, unmergeable): cleared once FILE is P again */
  private fileHold = false;
  /** a tuple whose bytes are at FILE (`at`: their hash) but whose directory fsync failed: not saved (CORR-153-1) */
  private unsynced: { T: Version; included: Map<string, number>; at: string } | null = null;
  /** sidecars whose names a save couldn't unlink, each holding its slot: unlinked again with the prevs */
  strays: string[] = [];
  /** the latest heads' reports and alternatives, for a tab that (re)connects: at most CONFLICTS_MAX reports and
   * CONFLICTS_MAX alternatives in all, oldest dropped first, each batch charged on the ledger while kept */
  changes: HeadEvent[] = [];
  private changeCharge = new Map<HeadEvent, number>();
  /** the seq of the latest batch dropped from `changes` */
  private droppedThrough = 0;
  private dirtySince: number | null = null;
  private lastWrite = -Infinity;
  /** retained prev files: path, last content hash ingested, the seq whose save includes it */
  prevs: { path: string; hash: string; base: Version; ingestedSeq: number; quietSince: number; invalid?: string }[] = [];
  events: HeadEvent[] = [];
  /** the last version ingested from FILE, with the hash of its bytes as read */
  private observed: { raw: string; version: Version } | null = null;
  /** MEMORY_MAX's ledger (§8.2): every kept version charged its Rv, every submission and outside version its R */
  readonly ledger: Ledger;
  private charged = new Map<Version, number>();
  /** the history window: the latest heads' seqs, at most HISTORY_PATCHES, dropped first by compaction */
  private window: number[] = [];
  /** tabs told `stale` by compaction (§8.2), for the server to send */
  staleTabs = new Set<string>();

  constructor(readonly file: string, readonly limits: Limits, private deps: HubDeps) {
    this.slots = new Slots(limits.BACKUPS_MAX);
    this.ledger = new Ledger(limits.MEMORY_MAX);
  }

  /** The hub on FILE's bytes as found (P₀), or why the board can't be edited. */
  async start(bytes: Buffer): Promise<{ ok: true } | { ok: false; why: string }> {
    const R = submitCharge(bytes);
    const res = this.ledger.admissible(R) ? this.ledger.reserve(R) : null;
    if (!res) return { ok: false, why: "it needs more memory than MEMORY_MAX allows" };
    let v: Awaited<ReturnType<EditHub["version"]>>;
    try { v = await this.version(bytes); if (!("why" in v)) { this.res = res; this.keep(v.version); } } finally { this.res = null; res.close(); }
    if ("why" in v) return { ok: false, why: v.why };
    this.P = this.H = v.version;
    this.O = hashOf(bytes);
    this.persistedSeq = this.writtenSeq = v.version.seq;
    this.remember(v.version);
    this.retainSave(v.version); // (P₀ among the retained saves while it lasts, §4.1)
    // (page ids given: written with the first save)
    if (v.given) this.dirty();
    return { ok: true };
  }

  /** Bytes as a version: parsed, editable (size, records, a lossless round trip), anonymous pages given ids. */
  private async version(bytes: Buffer): Promise<{ version: Version; given: boolean } | { why: string }> {
    if (bytes.length > this.limits.EDIT_MAX) return { why: `larger than EDIT_MAX (${this.limits.EDIT_MAX} bytes)` };
    let json: any;
    try { json = JSON.parse(bytes.toString("utf8")); } catch { return { why: "not a .board.json (not JSON)" }; }
    // (any failure past the parse, such as a value nested too deeply to walk, is the bytes' not being editable:
    // a reason, never an exception out of the watcher, CORR-153-7)
    try {
      const rt = roundTrips(json);
      if (!rt.ok) return { why: `the board can't be edited without losing something (at ${rt.at})` };
      const g = await givePageIds(json, hashOf(bytes));
      const records = editRecords(g.doc);
      if (records.length > this.limits.RECORDS_MAX) return { why: `more than RECORDS_MAX (${this.limits.RECORDS_MAX}) records` };
      const out = Buffer.from(serialize(g.doc), "utf8");
      const kept = g.given.length ? out : bytes;
      const charge = keptCharge(records);
      return { version: { seq: ++this.seq, records, json: g.doc, bytes: kept, hash: hashOf(kept), charge }, given: g.given.length > 0 };
    } catch (e) { return { why: `the board can't be read (${failure(e)})` }; }
  }

  /** an outside version waits for memory (§8.2: deferred, it waits in the watcher) */
  deferred = false;
  /** the reservation of the operation in progress, which every version it keeps is retained out of */
  private res: Reservation | null = null;

  /** A version kept: its Rv charged, once, retained out of the current operation's reservation (R covers it). */
  private keep(v: Version) {
    if (this.charged.has(v)) return;
    this.charged.set(v, v.charge);
    if (this.res) this.res.retain(v.charge);
    else { this.ledger.used += v.charge; this.ledger.peak = Math.max(this.ledger.peak, this.ledger.used); }
  }

  /** A head: servable by its seq, in the history window. */
  private remember(v: Version) {
    this.keep(v);
    this.heads.set(v.seq, v);
    this.window.push(v.seq);
    while (this.window.length > this.limits.HISTORY_PATCHES) this.window.shift();
    this.account();
  }

  /** the tuple being written, while it is */
  private writing: Version | null = null;

  /**
   * What is still referenced, each reference independent of the others: H, P, the tuple being written, each
   * tab's pinned head, prevs' ingestion bases, the last observed version; and the comparison history (the
   * retained saves and the window), the only references compaction drops.
   */
  private referenced(): Set<Version> {
    const out = new Set<Version>([this.H, this.P, ...this.saves]);
    if (this.writing) out.add(this.writing);
    for (const seq of this.window) { const v = this.heads.get(seq); if (v) out.add(v); }
    for (const t of this.tabs.values()) { const v = t.pin === undefined ? undefined : this.heads.get(t.pin); if (v) out.add(v); }
    for (const p of this.prevs) out.add(p.base);
    if (this.observed) out.add(this.observed.version);
    return out;
  }

  /** Versions no longer referenced released; then, past half of MEMORY_MAX, compaction (§8.2, addendum 2). */
  private account() {
    if (!this.H || !this.P) return;
    const release = () => {
      const refs = this.referenced();
      for (const [v, n] of this.charged) if (!refs.has(v)) { this.charged.delete(v); this.ledger.release(n); }
      for (const [seq, v] of this.heads) if (!refs.has(v)) this.heads.delete(seq);
    };
    release();
    const half = this.ledger.max / 2;
    // (the window first, oldest first; then the retained saves other than P, oldest first; then the stalest tab's pin)
    while (this.ledger.used > half && this.window.length) { this.window.shift(); release(); }
    // (then the kept reports, oldest first: a tab that connects later is told they are incomplete)
    while (this.ledger.used > half && this.changes.length) this.dropChange();
    while (this.ledger.used > half && this.saves.some((v) => v !== this.P)) { this.saves.splice(this.saves.findIndex((v) => v !== this.P), 1); release(); }
    while (this.ledger.used > half) {
      const pinned = [...this.tabs].filter(([, t]) => t.pin !== undefined && t.pin !== this.H.seq && t.pin !== this.P.seq).sort(([, a], [, b]) => a.lastSeen - b.lastSeen);
      if (!pinned.length) break;
      const [tab, t] = pinned[0];
      t.pin = undefined;
      this.staleTabs.add(tab);
      release();
    }
  }

  /** One merge's ledger and deadline (§8.3, addendum 1 A2): every phase charged to MERGE_WORK, run under MERGE_MS. */
  private budget(): Budget {
    const deadline = this.deps.now() + this.limits.MERGE_MS, max = this.limits.MERGE_WORK;
    const b: Budget = {
      used: 0,
      deadline,
      // (using exactly the ledger succeeds; the next unit, or the clock past the deadline, refuses)
      charge: (n) => { b.used += n; return b.used <= max && this.deps.now() <= deadline; },
      left: () => max - b.used,
      why: () => (b.used > max ? "work" : "time"),
    };
    return b;
  }

  private merge(base: Rec[], a: Rec[], b: Rec[], budget = this.budget()) {
    const r = boardMerge3(base, a, b, { work: budget.left(), deadline: budget.deadline, now: this.deps.now });
    budget.used += r.used;
    return r;
  }

  /** The merged records as the next head, or why not (a head is bounded as FILE is: EDIT_MAX, RECORDS_MAX; its serialization charged). */
  private nextHead(records: Rec[], budget: Budget): Made | { why: string } {
    if (records.length > this.limits.RECORDS_MAX) return { why: `the merged board has more than RECORDS_MAX (${this.limits.RECORDS_MAX}) records` };
    const json = fromEditRecords(records);
    const bytes = Buffer.from(serialize(json), "utf8");
    if (bytes.length > this.limits.EDIT_MAX) return { why: `the merged board is larger than EDIT_MAX (${this.limits.EDIT_MAX} bytes)` };
    if (!budget.charge(2 * bytes.length + records.length)) return { why: `can't merge (${budget.why()})` };
    // (everything that can fail made before anything changes: newHead only installs it)
    return { json, bytes, hash: hashOf(bytes), charge: keptCharge(records) };
  }

  /**
   * A batch of reports and alternatives, as kept and sent: each list at most CONFLICTS_MAX, what is cut counted;
   * and its charge while kept.  One that can't be serialized (a value nested too deeply) is kept as its count only.
   */
  private batch(seq: number, source: HeadEvent["source"], reports: HubReport[], alternatives: MergeAlternative[]): { e: HeadEvent; charge: number } {
    const max = this.limits.CONFLICTS_MAX;
    let omitted = Math.max(0, reports.length - max) + Math.max(0, alternatives.length - max);
    const e: HeadEvent = { seq, persistedSeq: this.persistedSeq, reports: reports.slice(0, max), alternatives: alternatives.slice(0, max), source };
    let charge = 0;
    try { charge = keptCharge([{ changes: [e] }]); } catch { omitted += e.reports.length + e.alternatives.length; e.reports = []; e.alternatives = []; }
    if (omitted) e.omitted = omitted;
    return { e, charge };
  }

  private newHead(records: Rec[], source: HeadEvent["source"], reports: HubReport[], alternatives: MergeAlternative[], made: Made): Version {
    const v: Version = { seq: ++this.seq, records, json: made.json, bytes: made.bytes, hash: made.hash, charge: made.charge };
    this.H = v;
    const { e, charge } = this.batch(v.seq, source, reports, alternatives);
    this.events.push(e);
    this.keepChanges(e, charge);
    this.remember(v);
    return v;
  }

  /**
   * A head's reports and alternatives kept for the tabs that (re)connect later (CORR-153-4): the latest batches,
   * at most CONFLICTS_MAX reports and CONFLICTS_MAX alternatives in all, oldest dropped first; each charged on
   * the ledger while it is kept.
   */
  private keepChanges(e: HeadEvent, n: number) {
    if (!e.reports.length && !e.alternatives.length && !e.omitted) return;
    // (admitted on top of what the operation reserved, as an outside version's own Rv is: without the room now,
    // only its count is kept, and a tab that connects later is told how many it missed)
    if (!this.ledger.admit(n)) { e = { ...e, reports: [], alternatives: [], omitted: (e.omitted ?? 0) + e.reports.length + e.alternatives.length }; n = 0; }
    this.changeCharge.set(e, n);
    this.changes.push(e);
    const max = this.limits.CONFLICTS_MAX;
    const count = (k: "reports" | "alternatives") => this.changes.reduce((s, c) => s + c[k].length, 0);
    while (this.changes.length > 1 && (count("reports") > max || count("alternatives") > max)) this.dropChange();
  }
  private dropChange() {
    const old = this.changes.shift()!;
    this.droppedThrough = Math.max(this.droppedThrough, old.seq);
    this.ledger.release(this.changeCharge.get(old) ?? 0);
    this.changeCharge.delete(old);
  }

  /** The kept batches after `seq` (and whether any after it were dropped), for /changes and a tab's first event. */
  changesAfter(seq: number): { changes: HeadEvent[]; complete: boolean; charge: number } {
    const out = this.changes.filter((c) => c.seq > seq);
    // (complete: no batch after seq was dropped)
    return { changes: out, complete: this.droppedThrough <= seq, charge: out.reduce((s, c) => s + (this.changeCharge.get(c) ?? 0), 0) };
  }

  private dirty() { if (this.dirtySince === null) this.dirtySince = this.deps.now(); }

  /** An outside version seen at FILE (null: FILE absent). */
  async observe(bytes: Buffer | null, base: Version = this.P): Promise<Version | undefined> {
    // (absent: no bytes observed, so FILE's coming back, as anything, is a change, CORR-153-2)
    if (bytes === null) { this.O = ""; this.holdFile("deleted", "FILE was deleted or moved"); return; }
    const h = hashOf(bytes);
    if (h === this.P.hash) {
      // (FILE is P again: a hold FILE caused (invalid, deleted, unmergeable) is over, and what H has beyond P is due
      // to be saved, CORR-153-2; a hold of another cause stays)
      this.O = h;
      this.deferred = false;
      if (this.unsynced && this.unsynced.at !== h) this.unsynced = null;
      if (this.fileHold) { this.fileHold = false; this.state = { state: "ok" }; }
      if (this.H.seq !== this.P.seq) this.dirty();
      return;
    }
    if (h === this.O) return;
    const v = await this.ingest(bytes, base);
    // (no memory for it now: not taken as observed, so the next read tries again; the save's W2 check sees it too)
    if ("deferred" in v) { this.deferred = true; return; }
    this.deferred = false;
    this.O = h;
    // (FILE isn't the bytes a failed fsync left any more: nothing to sync, the next save writes)
    if (this.unsynced && this.unsynced.at !== h) this.unsynced = null;
    if ("why" in v) { this.holdFile(v.held, v.why); return; }
    // (FILE valid and merged: whatever held saving is over)
    this.ok();
    this.observed = { raw: h, version: v };
    // (the file already holds the board's state: adopted as the latest save, nothing written)
    if (canon(this.H.records) === canon(v.records)) this.adopt(h);
    return v;
  }

  /** A hold FILE caused: cleared when FILE is P again (or a version of it is merged). */
  holdFile(why: "invalid" | "deleted" | "unmergeable", detail: string) { this.state = { state: "held", why, detail }; this.fileHold = true; }
  /** A hold of another cause (slots, stuck, error, a prev's version): FILE's coming back doesn't clear it. */
  private hold(why: Exclude<HubState, { state: "ok" }>["why"], detail: string) { this.state = { state: "held", why, detail }; this.fileHold = false; }
  private ok() { this.state = { state: "ok" }; this.fileHold = false; }

  /**
   * FILE, whose bytes (hash `at`) are exactly H, adopted as the latest save (§4.1), and so as saved for each
   * tab whose ops H includes (CORR-153-3): durable as a save of ours is, so FILE and its directory are fsynced
   * first; if that fails, nothing is advanced, and the sync is retried as a save (CORR-153-1).
   */
  private adopt(at: string) {
    const T = this.H, included = new Map(this.includedGens);
    const m = this.sync(at);
    if (typeof m === "string") { this.unsynced = { T, included, at }; this.dirty(); this.failing(m); return; }
    this.completed(T, included, m.durable);
  }

  /** FILE (still the bytes `at`) and its directory fsynced: {durable} (false: the directory couldn't be on this
   * platform), or why not. */
  private sync(at: string): { durable: boolean } | string {
    const f = this.deps.fs ?? realFs;
    try {
      if (hashOf(f.readFile(this.file)) !== at) return "FILE changed";
      f.fsync(this.file);
      return { durable: f.fsyncDir(dirname(this.file)) };
    } catch (e: any) { return String(e?.code ?? e?.message ?? e); }
  }

  /**
   * A tuple at FILE: P and writtenSeq and each tab's writtenGen advanced from it; and, if durable (its directory
   * fsynced), persistedSeq and each tab's persistedGen too, what Saved means (§5.1, §6.5).  Not durable: written,
   * on a platform that can't sync a directory, and never shown as Saved; not retried (it can't be done there).
   */
  private completed(T: Version, included: Map<string, number>, durable = true) {
    this.failingSince = null;
    this.unsynced = null;
    this.P = T;
    this.writtenSeq = T.seq;
    for (const [tab, gen] of included) this.writtenGens.set(tab, Math.max(this.writtenGens.get(tab) ?? 0, gen));
    if (durable) {
      this.persistedSeq = T.seq;
      for (const [tab, gen] of included) this.persistedGens.set(tab, Math.max(this.persistedGens.get(tab) ?? 0, gen));
    }
    this.retainSave(T);
    if (this.H.seq === T.seq) this.dirtySince = null;
    this.ok();
    this.events.push({ seq: this.H.seq, persistedSeq: this.persistedSeq, writtenSeq: this.writtenSeq, reports: [], alternatives: [], source: "save" });
  }

  /** A save that didn't complete: retried as the write queue paces it; after WRITE_RETRY_MS, shown as not saved. */
  private failing(message: string) {
    const now = this.deps.now();
    this.failingSince ??= now;
    if (now - this.failingSince >= this.limits.WRITE_RETRY_MS) this.hold("error", message);
  }

  /** Bytes read at FILE or from a prev, merged against `base` into H (§4.2): the version they are, or why not. */
  private async ingest(bytes: Buffer, base: Version): Promise<Version | { why: string; held: "invalid" | "unmergeable" } | { deferred: true }> {
    // (memory first: R, reserved before the bytes are parsed; what is kept retained out of it, the rest released)
    const R = submitCharge(bytes);
    if (!this.ledger.admissible(R)) return { why: "it needs more memory than MEMORY_MAX allows", held: "invalid" };
    const res = this.ledger.reserve(R);
    if (!res) return { deferred: true };
    this.res = res;
    // (a failure no check foresaw, a value nested too deeply say: the version can't be merged, H unchanged, CORR-153-7)
    try { return await this.ingestWithin(bytes, base); } catch (e) { return { why: `can't merge (${failure(e)})`, held: "unmergeable" }; } finally { this.res = null; res.close(); this.account(); }
  }

  private async ingestWithin(bytes: Buffer, base: Version): Promise<Version | { why: string; held: "invalid" | "unmergeable" } | { deferred: true }> {
    const budget = this.budget();
    // (parsed, checked, given page ids and serialized: four passes over the bytes)
    if (!budget.charge(4 * bytes.length)) return { why: `can't merge (${budget.why()})`, held: "unmergeable" };
    const v = await this.version(bytes);
    if ("why" in v) return { why: v.why, held: "invalid" };
    const C = v.version;
    // (C is kept too, as the observed version or a prev's base: R covers it while it is made, and only the merged
    // head is retained out of R; C's own Rv is admitted on top, or the version waits)
    if (!this.charged.has(C)) {
      if (!this.ledger.admit(C.charge)) return { deferred: true };
      this.charged.set(C, C.charge);
    }
    const r = this.merge(base.records, this.H.records, C.records, budget);
    if ("refused" in r) return { why: `can't merge (${r.refused})`, held: "unmergeable" };
    const made = this.nextHead(r.records, budget);
    if ("why" in made) return { why: made.why, held: "unmergeable" };
    // (§4.3: the merge's reports, then the older-copy flags, then every change the version made to the head, each
    // with the board's previous value as its restore, CORR-153-8)
    const changed = this.outsideChanges(this.H.records, r.records, budget);
    if ("why" in changed) return { why: changed.why, held: "unmergeable" };
    const reports: HubReport[] = [...r.reports, ...this.olderCopy(C.records), ...changed.reports];
    const alternatives = [...r.alternatives, ...changed.alternatives];
    const adopted = canon(r.records) === canon(C.records);
    this.newHead(r.records, "outside", reports, alternatives, made);
    if (!adopted) this.dirty();
    return C;
  }

  /**
   * What merging an outside version changed in the head, field by field (a record added or removed whole), with
   * the head's value before it as each one's restore (§4.3); charged a unit per record and per field compared.
   */
  private outsideChanges(before: Rec[], after: Rec[], budget: Budget): { reports: HubReport[]; alternatives: MergeAlternative[] } | { why: string } {
    const reports: HubReport[] = [], alternatives: MergeAlternative[] = [];
    if (!budget.charge(before.length + after.length)) return { why: `can't merge (${budget.why()})` };
    const old = new Map(before.map((r) => [keyOf(r), r])), now = new Map(after.map((r) => [keyOf(r), r]));
    const val = (r: Rec, f: string) => (Object.prototype.hasOwnProperty.call(r, f) && r[f] !== undefined ? r[f] : ABSENT);
    for (const [k, a] of now) {
      const b = old.get(k);
      if (!b) { reports.push({ kind: "outside", key: k, was: ABSENT, now: a }); alternatives.push({ key: k, record: null }); continue; }
      const fields = new Set([...Object.keys(b), ...Object.keys(a)]);
      if (!budget.charge(fields.size)) return { why: `can't merge (${budget.why()})` };
      for (const f of fields) {
        const was = val(b, f), is = val(a, f);
        if (was === is || (was !== ABSENT && is !== ABSENT && canon(was) === canon(is))) continue;
        reports.push({ kind: "outside", key: k, field: f, was, now: is });
        alternatives.push({ key: k, field: f, value: was });
      }
    }
    for (const [k, b] of old) if (!now.has(k)) { reports.push({ kind: "outside", key: k, was: b, now: ABSENT }); alternatives.push({ key: k, record: b }); }
    return { reports, alternatives };
  }

  // ---- prev files (§5.3)
  /**
   * Each retained prev's content, read again (every WATCH_MS, by the caller): a content that differs from the last
   * one ingested is ingested, against that one (or, for none yet, the P current at the save's W2).  A prev is
   * unlinked, its slot released, once its content has been the same for `quietMs`, its last content has been
   * ingested, and a save including that has completed.  One whose content can't be read as a board is kept and
   * reported, never unlinked.
   */
  /**
   * At a clean exit, after the last save: each retained prev unlinked if its content is still the one last
   * read and that is in a completed save; one that changed since (a write the board can no longer take in)
   * or isn't saved yet is kept, and its path returned.
   */
  closePrevs(): string[] {
    const f = this.deps.fs ?? realFs, kept: string[] = [];
    for (const p of [...this.prevs]) {
      let bytes: Buffer | null = null;
      try { bytes = f.readFile(p.path); } catch { bytes = null; }
      if (bytes !== null && (hashOf(bytes) !== p.hash || p.invalid !== undefined || p.ingestedSeq > this.writtenSeq)) { kept.push(p.path); continue; }
      if (bytes !== null) { try { f.unlink(p.path); } catch { kept.push(p.path); continue; } }
      this.prevs.splice(this.prevs.indexOf(p), 1);
      this.slots.release(1);
    }
    return kept;
  }

  async tickPrevs(quietMs: number): Promise<void> {
    const f = this.deps.fs ?? realFs;
    // (a sidecar a save couldn't unlink: tried again, its slot released once its name is gone)
    for (const s of [...this.strays]) {
      try { f.unlink(s); } catch (e: any) { if (e?.code !== "ENOENT") continue; }
      this.strays.splice(this.strays.indexOf(s), 1);
      this.slots.release(1);
    }
    for (const p of [...this.prevs]) await this.readPrev(p, quietMs);
  }

  /** One retained prev read again: a new content ingested against the last; unlinked once quiet, ingested and saved. */
  private async readPrev(p: EditHub["prevs"][number], quietMs = Infinity): Promise<void> {
    const f = this.deps.fs ?? realFs;
    let bytes: Buffer;
    try { bytes = f.readFile(p.path); } catch {
      // (gone: removed by someone else; its name no longer beside FILE)
      this.prevs.splice(this.prevs.indexOf(p), 1);
      this.slots.release(1);
      return;
    }
    const h = hashOf(bytes), now = this.deps.now();
    if (h !== p.hash) {
      if (h === p.base.hash) { p.hash = h; p.quietSince = now; p.ingestedSeq = Math.min(p.ingestedSeq, this.H.seq); return; }
      const v = await this.ingest(bytes, p.base);
      // (no memory for it now: read again next time)
      if ("deferred" in v) return;
      p.hash = h;
      p.quietSince = now;
      if ("why" in v) {
        if (v.held === "unmergeable") this.hold("unmergeable", v.why);
        p.ingestedSeq = Infinity;
        p.invalid = v.why;
        const { e, charge } = this.batch(this.H.seq, "outside", [{ kind: "prev-kept", path: p.path, why: v.why }], []);
        this.events.push(e);
        this.keepChanges(e, charge);
        this.account();
        return;
      }
      // (merged: a prev's own hold is over; a hold FILE caused isn't, FILE being what it is)
      if (!this.fileHold && this.state.state === "held" && this.state.why === "unmergeable") this.ok();
      p.base = v;
      p.invalid = undefined;
      p.ingestedSeq = this.H.seq;
      return;
    }
    // (written, durable or not: where the directory can't be synced, nothing would ever confirm more, and a prev
    // held for it would only fill BACKUPS_MAX and stop saving)
    if (p.invalid === undefined && now - p.quietSince >= quietMs && p.ingestedSeq <= this.writtenSeq) {
      try { f.unlink(p.path); } catch (e: any) { if (e?.code !== "ENOENT") return; }
      this.prevs.splice(this.prevs.indexOf(p), 1);
      this.slots.release(1);
    }
  }

  /** §4.3: fields where C differs from P and equals one of the retained saves (where that save had it otherwise than P). */
  private olderCopy(C: Rec[]): HubReport[] {
    const out: HubReport[] = [];
    const P = new Map(this.P.records.map((r) => [keyOf(r), r]));
    const olds = this.saves.filter((s) => s.seq !== this.P.seq).map((s) => new Map(s.records.map((r) => [keyOf(r), r])));
    const Cs = new Map(C.map((r) => [keyOf(r), r]));
    const show = (r: Rec | undefined, f: string) => (r && r[f] !== undefined ? r[f] : ABSENT);
    for (const [k, c] of Cs) {
      const p = P.get(k);
      // (a record C has and P doesn't: from an older copy if a retained save had it, as C has it)
      if (!p) {
        if (olds.some((o) => { const r = o.get(k); return r !== undefined && canon(r) === canon(c); })) out.push({ kind: "older-copy", key: k, value: c, board: ABSENT });
        continue;
      }
      for (const f of new Set([...Object.keys(c), ...Object.keys(p)])) {
        const cv = canon(c[f]), pv = canon(p[f]);
        if (cv === pv) continue;
        // (absent included: a save that had the record without the field, as C has it)
        if (olds.some((o) => { const r = o.get(k); return r !== undefined && canon(r[f]) === cv && canon(r[f]) !== pv; })) {
          out.push({ kind: "older-copy", key: k, field: f, value: show(c, f), board: show(p, f) });
        }
      }
    }
    // (a record P has and C doesn't: from an older copy if a retained save didn't have it)
    for (const [k, p] of P) if (!Cs.has(k) && olds.some((o) => !o.has(k))) out.push({ kind: "older-copy", key: k, value: ABSENT, board: p });
    return out;
  }

  private retainSave(v: Version) {
    this.saves.push(v);
    while (this.saves.length > this.limits.SAVES_KEPT) this.saves.shift();
  }

  // ---- tabs (§6.2)
  /**
   * What a submission is answered without its body, from its URL alone (CORR-BOARD-A1-1), or null when its body
   * is to be read: an unknown tab; a tombstoned one (told what is included: it isn't made live here, since only a
   * tab's event stream owns a live record, connect(); CORR-153-R2-2); a gen at or below the watermark (replayed by
   * its hash, a mismatch, or included); a base the hub doesn't hold (stale).
   */
  before(tab: string, gen: number, baseSeq: number, hash: string): SubmitAnswer | null {
    const op = `${tab}:${gen}`;
    let t = this.tabs.get(tab);
    if (!t) {
      const w = this.tombstones.get(tab);
      if (w === undefined) return { op, unknownTab: true };
      // (known only by its tombstone: told its watermark, nothing applied, the tombstone kept; it is reactivated
      // when it connects its events again, so no live record, nor a rate bucket, exists without a stream)
      return { op, included: w, seq: this.H.seq };
    }
    t.lastSeen = this.deps.now();
    if (gen <= t.watermark) {
      const a = t.acks.find((x) => x.gen === gen);
      if (!a) return { op, included: t.watermark, seq: this.H.seq };
      return a.hash === hash ? { op, accepted: true, seq: a.seq } : { op, mismatch: true };
    }
    if (!this.heads.has(baseSeq)) return { op, stale: true, seq: this.H.seq };
    return null;
  }

  /**
   * A tab's submission: its snapshot S (records as JSON lines, the request's body) made from the head it adopted
   * last (baseSeq), and the SHA-256 of the body's bytes.  Memory first (addendum 2): R = 18·b + 256·t reserved
   * before the body is parsed, refused for good past MEMORY_MAX / 2, busy if it doesn't fit now; `bodyCharged`,
   * what the server charged for the body's bytes as they arrived, is taken over by R.  The new head's Rv is
   * retained out of R and the rest released, on every path.
   */
  submit(tab: string, gen: number, baseSeq: number, body: Buffer | string, hash: string, bodyCharged = 0): SubmitAnswer {
    const op = `${tab}:${gen}`;
    const early = this.before(tab, gen, baseSeq, hash);
    if (early) { this.ledger.release(bodyCharged); return early; }
    const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const R = submitCharge(bytes);
    // (the body's own charge given back as R is taken: R covers the body)
    this.ledger.release(bodyCharged);
    if (!this.ledger.admissible(R)) return { op, refused: `the snapshot needs more memory than MEMORY_MAX allows (${R} bytes, at most ${Math.floor(this.ledger.max / 2)})` };
    const res = this.ledger.reserve(R);
    if (!res) return { op, busy: "memory" };
    this.res = res;
    // (a failure no check foresaw, a value nested too deeply say: refused, nothing changed, CORR-153-7; every
    // change submitWithin makes comes after its last step that can fail)
    try { return this.submitWithin(this.tabs.get(tab)!, op, gen, this.heads.get(baseSeq)!, bytes, hash); }
    catch (e) { return { op, refused: `the snapshot can't be taken (${failure(e)})` }; }
    finally { this.res = null; res.close(); this.account(); }
  }

  private submitWithin(t: TabRecord, op: string, gen: number, base: Version, bytes: Buffer, hash: string): SubmitAnswer {
    // (every phase on the one ledger and deadline: hashed, parsed, decoded and checked, four passes over the bytes)
    const budget = this.budget(), size = bytes.length;
    if (!budget.charge(size)) return { op, refused: `can't merge (${budget.why()})` };
    if (sha(bytes) !== hash) return { op, refused: "the snapshot's hash doesn't match" };
    if (!budget.charge(size)) return { op, refused: `can't merge (${budget.why()})` };
    let records: Rec[];
    try { records = bytes.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return { op, refused: "the snapshot isn't JSON lines" }; }
    if (records.length > this.limits.RECORDS_MAX) return { op, refused: `more than RECORDS_MAX (${this.limits.RECORDS_MAX}) records` };
    if (!budget.charge(2 * size + records.length)) return { op, refused: `can't merge (${budget.why()})` };
    // (the records exactly the board they decode to, every one and every field: CORR-BOARD-A1-2; and that board's
    // bytes as written exactly it)
    const are = recordsAre(records);
    if (!are.ok) return { op, refused: `the snapshot isn't a board's records (${are.at})` };
    if (!bytesAre(serialize(are.doc), are.doc).ok) return { op, refused: "the snapshot can't be written without losing something" };
    const r = this.merge(base.records, this.H.records, records, budget);
    if ("refused" in r) return { op, refused: `can't merge (${r.refused})` };
    const made = this.nextHead(r.records, budget);
    if ("why" in made) return { op, refused: made.why };
    const tab = op.slice(0, op.lastIndexOf(":"));
    this.newHead(r.records, "tab", r.reports, r.alternatives, made);
    this.includedGens.set(tab, gen);
    t.watermark = gen;
    t.pin = base.seq;
    t.acks.push({ gen, seq: this.H.seq, hash });
    while (t.acks.length > this.limits.ACKS_KEPT) t.acks.shift();
    this.dirty();
    return { op, accepted: true, seq: this.H.seq };
  }

  /** A tab was sent head `seq` (/board?at=): the head it may name as its base next, pinned (§8.2). */
  adopted(tab: string, seq: number) { const t = this.tabs.get(tab); if (t && this.heads.has(seq)) { t.pin = seq; this.account(); } }


  /** A tab connected (its record made, if new). */
  connect(tab: string) {
    if (this.tabs.has(tab)) return;
    // (a released tab reconnecting: reactivated from its tombstone, its watermark kept, no acks; its first event
    // tells it what is included, CORR-153-R2-2)
    const w = this.tombstones.get(tab);
    this.tombstones.delete(tab);
    this.tabs.set(tab, { watermark: w ?? 0, acks: [], lastSeen: this.deps.now(), pin: this.H.seq });
  }

  /** A tab released (disconnected): its accounting released, a tombstone of its watermark kept. */
  release(tab: string) {
    const t = this.tabs.get(tab);
    if (!t) return;
    this.tabs.delete(tab);
    this.tombstones.set(tab, t.watermark);
    while (this.tombstones.size > this.limits.TAB_TOMBSTONES) {
      // (a tab forgotten: what is included and saved of its ops too)
      const old = this.tombstones.keys().next().value!;
      this.tombstones.delete(old);
      this.includedGens.delete(old);
      this.persistedGens.delete(old);
      this.writtenGens.delete(old);
    }
    this.account(); // (its pinned head released)
  }

  /** What a tab is told with each head: the highest gen of its ops in it, and its persistedGen. */
  tabView(tab: string) {
    return { includes: this.includedGens.get(tab) ?? 0, persistedGen: this.persistedGens.get(tab) ?? 0, writtenGen: this.writtenGens.get(tab) ?? 0 };
  }

  head(seq: number): Version | undefined { return this.heads.get(seq); }

  // ---- saving (§5)
  /** Whether a save is due now: something unsaved, quiet for SAVE_QUIET_MS (or waiting SAVE_MAX_DELAY_MS), WRITE_MIN_MS since the last. */
  due(now = this.deps.now(), immediate = false): boolean {
    if (this.dirtySince === null || this.H.seq === this.P.seq) return false;
    if (this.state.state === "held" && this.state.why !== "error" && this.state.why !== "slots") return false;
    if (now - this.lastWrite < this.limits.WRITE_MIN_MS) return false;
    return immediate || now - this.dirtySince >= this.limits.SAVE_QUIET_MS || now - this.dirtySince >= this.limits.SAVE_MAX_DELAY_MS;
  }

  /** One save of the frozen head, now. */
  async save(): Promise<SaveOutcome> {
    // (one write queue: a save asked for while one runs follows it, r7 §5.6)
    const run = (this.saving ?? Promise.resolve()).catch(() => {}).then(async () => {
      const T = this.H; // (the frozen tuple: its value, seq and bytes)
      this.writing = T;
      try { return await this.saveTuple(T); } finally { this.writing = null; this.account(); }
    });
    this.saving = run;
    try { return await run; } finally { if (this.saving === run) this.saving = null; }
  }
  private saving: Promise<SaveOutcome> | null = null;
  /** since when saves have been failing (an error outcome), or null */
  private failingSince: number | null = null;

  /** Whether anything is unsaved that a save could write now (the exit flush's test: no WRITE_MIN_MS, no quiet). */
  unsaved(): boolean {
    if (this.H.seq === this.P.seq) return false;
    return !(this.state.state === "held" && this.state.why !== "error" && this.state.why !== "slots");
  }

  private async saveTuple(T: Version): Promise<SaveOutcome> {
    const included = new Map(this.includedGens);
    this.lastWrite = this.deps.now();
    const before = this.P, O = this.O;
    // (a tuple already at FILE whose directory fsync failed: only the sync again, CORR-153-1)
    const u = this.unsynced;
    if (u && u.T === T && u.at === O) {
      const m = this.sync(O);
      if (typeof m !== "string") { this.completed(T, u.included, m.durable); return m.durable ? { saved: true, resynced: true } : { saved: true, resynced: true, durable: false }; }
      this.failing(m);
      return { saved: false, why: "unsynced", message: m };
    }
    // (the version at FILE as last observed: what the inode a save sets aside as prev holds)
    const atO = this.observed?.raw === O ? this.observed.version : u?.at === O ? u.T : before;
    const r = writeOnce(this.file, T.bytes, O, this.slots, { fs: this.deps.fs });
    if (r.stray) this.strays.push(...r.stray);
    const now = this.deps.now();
    // (a retained name a program may still write through an old handle: watched (§5.3, CORR-153-5); `hash` its
    // content as last read ("": not read yet, so read at once), `base` that content's version)
    const watch = (path: string, hash: string, base: Version, ingestedSeq: number) => this.prevs.push({ path, hash, base, ingestedSeq, quietSince: now });
    if (r.saved) {
      this.O = T.hash;
      watch(r.prev, O, atO, T.seq);
      this.completed(T, included, r.durable !== false);
      return r;
    }
    switch (r.why) {
      case "changed": await this.observe(r.bytes); break;
      case "classified": {
        // (C, the bytes W4 read, is an observed version made from the P current at W2; prev retained, C its base)
        const p = { path: r.prev, hash: hashOf(r.bytes), base: before, ingestedSeq: Infinity, quietSince: now };
        this.prevs.push(p);
        const v = await this.observe(r.bytes, before);
        // (or, already seen at FILE: the version it was then)
        const seen = v ?? (this.observed?.raw === p.hash ? this.observed.version : this.P.hash === p.hash ? this.P : undefined);
        if (seen && this.state.state === "ok") { p.base = seen; p.ingestedSeq = this.H.seq; }
        break;
      }
      case "replaced": watch(r.prev, O, atO, T.seq); break;
      case "unsynced":
        // (FILE holds T's bytes, not durably: observed as such, P not advanced; the sync retried as a save)
        this.O = T.hash;
        this.unsynced = { T, included, at: T.hash };
        if (r.prev) watch(r.prev, O, atO, T.seq);
        this.failing(r.message);
        break;
      case "deleted":
        this.O = "";
        if (r.prev) watch(r.prev, O, atO, T.seq);
        this.holdFile("deleted", "FILE was deleted or moved");
        break;
      case "slots": this.hold("slots", "too many copies kept beside FILE, waiting for them to settle"); break;
      case "stuck":
      case "eexist": {
        // (prev, the classified inode; prev2, a version not read yet, read now, before the new FILE is: in the
        // order they were seen; tmp, T's own bytes, kept with the rest)
        watch(r.prev, O, atO, T.seq);
        if (r.why === "stuck" && r.tmp) watch(r.tmp, T.hash, T, T.seq);
        if (r.outside) watch(r.outside, "", before, Infinity);
        if (r.why === "stuck") { this.O = ""; this.hold("stuck", `FILE is missing: kept at ${r.kept.join(", ")}`); }
        else this.hold("error", `a new FILE appeared during the save; kept ${r.kept.join(", ")}`);
        if (r.outside) await this.readPrev(this.prevs[this.prevs.length - 1]);
        break;
      }
      case "error":
        // (a failing write retried, as the write queue paces it, for WRITE_RETRY_MS (Windows: FILE open in another
        // program), then reported as not saved; still retried after that)
        this.failing(r.message);
        break;
    }
    return r;
  }
}
