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
import { boardMerge3, keyOf, canon, type Rec, type MergeReport, type MergeAlternative } from "../web/board/merge";
import { editRecords, fromEditRecords, roundTrips, givePageIds, serialize, bytesAre, recordsAre } from "../web/board/lossless";
import { writeOnce, Slots, hashOf, realFs, type WriteFs, type WriteOutcome } from "./board-edit-write";
import type { Limits } from "./board-edit-limits";
import { Ledger, Reservation, submitCharge, keptCharge } from "./board-edit-memory";

/** A version the hub keeps; `charge` its Rv on the ledger (src/board-edit-memory.ts). */
export interface Version { seq: number; records: Rec[]; json: any; bytes: Buffer; hash: string; charge: number }
export type HubReport =
  | MergeReport
  | { kind: "older-copy"; key: string; field: string; value: unknown; board: unknown }
  | { kind: "prev-kept"; path: string; why: string };
export interface HeadEvent { seq: number; persistedSeq: number; reports: HubReport[]; alternatives: MergeAlternative[]; source: "outside" | "tab" | "save" }
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

interface Budget { used: number; deadline: number; charge: (n: number) => boolean; left: () => number; why: () => "work" | "time" }

interface TabRecord { watermark: number; acks: { gen: number; seq: number; hash: string }[]; persistedGen: number; lastSeen: number; pin?: number }

export interface HubDeps {
  mergeStrings3: (o: { base: string; a: string; b: string }) => string;
  now: () => number;
  fs?: WriteFs;
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const lines = (rs: Rec[]) => rs.map((r) => JSON.stringify(r)).join("\n");

export class EditHub {
  P!: Version;
  H!: Version;
  O = "";
  persistedSeq = 0;
  private seq = 0;
  private saves: Version[] = [];
  private heads = new Map<number, Version>();
  private tabs = new Map<string, TabRecord>();
  private tombstones = new Map<string, number>();
  private includedGens = new Map<string, number>(); // (per tab, the highest gen whose op is in H)
  readonly slots: Slots;
  state: HubState = { state: "ok" };
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
    this.persistedSeq = v.version.seq;
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
    const rt = roundTrips(json);
    if (!rt.ok) return { why: `the board can't be edited without losing something (at ${rt.at})` };
    const g = await givePageIds(json, hashOf(bytes));
    const records = editRecords(g.doc);
    if (records.length > this.limits.RECORDS_MAX) return { why: `more than RECORDS_MAX (${this.limits.RECORDS_MAX}) records` };
    const out = Buffer.from(serialize(g.doc), "utf8");
    const kept = g.given.length ? out : bytes;
    return { version: { seq: ++this.seq, records, json: g.doc, bytes: kept, hash: hashOf(kept), charge: keptCharge(records) }, given: g.given.length > 0 };
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
    const r = boardMerge3(base, a, b, { mergeStrings3: this.deps.mergeStrings3, work: budget.left(), deadline: budget.deadline, now: this.deps.now });
    budget.used += r.used;
    return r;
  }

  /** The merged records as the next head, or why not (a head is bounded as FILE is: EDIT_MAX, RECORDS_MAX; its serialization charged). */
  private nextHead(records: Rec[], budget: Budget): { json: any; bytes: Buffer } | { why: string } {
    if (records.length > this.limits.RECORDS_MAX) return { why: `the merged board has more than RECORDS_MAX (${this.limits.RECORDS_MAX}) records` };
    const json = fromEditRecords(records);
    const bytes = Buffer.from(serialize(json), "utf8");
    if (bytes.length > this.limits.EDIT_MAX) return { why: `the merged board is larger than EDIT_MAX (${this.limits.EDIT_MAX} bytes)` };
    if (!budget.charge(2 * bytes.length + records.length)) return { why: `can't merge (${budget.why()})` };
    return { json, bytes };
  }

  private newHead(records: Rec[], source: HeadEvent["source"], reports: HubReport[], alternatives: MergeAlternative[], made?: { json: any; bytes: Buffer }): Version {
    const json = made?.json ?? fromEditRecords(records);
    const bytes = made?.bytes ?? Buffer.from(serialize(json), "utf8");
    const v: Version = { seq: ++this.seq, records, json, bytes, hash: hashOf(bytes), charge: keptCharge(records) };
    this.H = v;
    this.remember(v);
    this.events.push({ seq: v.seq, persistedSeq: this.persistedSeq, reports: reports.slice(0, this.limits.CONFLICTS_MAX), alternatives: alternatives.slice(0, this.limits.CONFLICTS_MAX), source });
    return v;
  }

  private dirty() { if (this.dirtySince === null) this.dirtySince = this.deps.now(); }

  /** An outside version seen at FILE (null: FILE absent). */
  async observe(bytes: Buffer | null, base: Version = this.P): Promise<Version | undefined> {
    if (bytes === null) { this.state = { state: "held", why: "deleted", detail: "FILE was deleted or moved" }; return; }
    const h = hashOf(bytes);
    if (h === this.O || h === this.P.hash) { this.O = h; return; }
    const v = await this.ingest(bytes, base);
    // (no memory for it now: not taken as observed, so the next read tries again; the save's W2 check sees it too)
    if ("deferred" in v) { this.deferred = true; return; }
    this.deferred = false;
    this.O = h;
    if ("why" in v) { this.state = { state: "held", why: v.held, detail: v.why }; return; }
    this.observed = { raw: h, version: v };
    if (canon(this.H.records) === canon(v.records)) {
      // (the file already holds the board's state: adopted as the latest save, nothing written)
      this.P = this.H;
      this.persistedSeq = this.H.seq;
      this.retainSave(this.H);
    }
    return v;
  }

  /** Bytes read at FILE or from a prev, merged against `base` into H (§4.2): the version they are, or why not. */
  private async ingest(bytes: Buffer, base: Version): Promise<Version | { why: string; held: "invalid" | "unmergeable" } | { deferred: true }> {
    // (memory first: R, reserved before the bytes are parsed; what is kept retained out of it, the rest released)
    const R = submitCharge(bytes);
    if (!this.ledger.admissible(R)) return { why: "it needs more memory than MEMORY_MAX allows", held: "invalid" };
    const res = this.ledger.reserve(R);
    if (!res) return { deferred: true };
    this.res = res;
    try { return await this.ingestWithin(bytes, base); } finally { this.res = null; res.close(); this.account(); }
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
    this.state = { state: "ok" };
    const reports: HubReport[] = [...r.reports, ...this.olderCopy(C.records)];
    const head = this.newHead(r.records, "outside", reports, r.alternatives, made);
    if (canon(head.records) !== canon(C.records)) this.dirty();
    return C;
  }

  // ---- prev files (§5.3)
  /**
   * Each retained prev's content, read again (every WATCH_MS, by the caller): a content that differs from the last
   * one ingested is ingested, against that one (or, for none yet, the P current at the save's W2).  A prev is
   * unlinked, its slot released, once its content has been the same for `quietMs`, its last content has been
   * ingested, and a save including that has completed.  One whose content can't be read as a board is kept and
   * reported, never unlinked.
   */
  async tickPrevs(quietMs: number): Promise<void> {
    const f = this.deps.fs ?? realFs;
    for (const p of [...this.prevs]) {
      let bytes: Buffer;
      try { bytes = f.readFile(p.path); } catch {
        // (gone: removed by someone else; its name no longer beside FILE)
        this.prevs.splice(this.prevs.indexOf(p), 1);
        this.slots.release(1);
        continue;
      }
      const h = hashOf(bytes), now = this.deps.now();
      if (h !== p.hash) {
        if (h === p.base.hash) { p.hash = h; p.quietSince = now; p.ingestedSeq = Math.min(p.ingestedSeq, this.H.seq); continue; }
        const v = await this.ingest(bytes, p.base);
        // (no memory for it now: read again next time)
        if ("deferred" in v) continue;
        p.hash = h;
        p.quietSince = now;
        if ("why" in v) {
          if (v.held === "unmergeable") this.state = { state: "held", why: "unmergeable", detail: v.why };
          p.ingestedSeq = Infinity;
          p.invalid = v.why;
          this.events.push({ seq: this.H.seq, persistedSeq: this.persistedSeq, reports: [{ kind: "prev-kept", path: p.path, why: v.why }], alternatives: [], source: "outside" });
          continue;
        }
        p.base = v;
        p.invalid = undefined;
        p.ingestedSeq = this.H.seq;
        continue;
      }
      if (p.invalid === undefined && now - p.quietSince >= quietMs && p.ingestedSeq <= this.persistedSeq) {
        try { f.unlink(p.path); } catch (e: any) { if (e?.code !== "ENOENT") continue; }
        this.prevs.splice(this.prevs.indexOf(p), 1);
        this.slots.release(1);
      }
    }
  }

  /** §4.3: fields where C differs from P and equals one of the retained saves (where that save had it otherwise than P). */
  private olderCopy(C: Rec[]): HubReport[] {
    const out: HubReport[] = [];
    const P = new Map(this.P.records.map((r) => [keyOf(r), r]));
    const olds = this.saves.filter((s) => s.seq !== this.P.seq).map((s) => new Map(s.records.map((r) => [keyOf(r), r])));
    for (const c of C) {
      const k = keyOf(c), p = P.get(k);
      if (!p) continue;
      for (const f of new Set([...Object.keys(c), ...Object.keys(p)])) {
        const cv = canon(c[f]), pv = canon(p[f]);
        if (cv === pv) continue;
        if (olds.some((o) => { const r = o.get(k); return r && canon(r[f]) === cv && canon(r[f]) !== pv; })) {
          out.push({ kind: "older-copy", key: k, field: f, value: c[f], board: p[f] });
        }
      }
    }
    return out;
  }

  private retainSave(v: Version) {
    this.saves.push(v);
    while (this.saves.length > this.limits.SAVES_KEPT) this.saves.shift();
  }

  // ---- tabs (§6.2)
  /**
   * What a submission is answered without its body, from its URL alone (CORR-BOARD-A1-1), or null when its body
   * is to be read: an unknown tab; a tombstoned one (reactivated, told what is included); a gen at or below the
   * watermark (replayed by its hash, a mismatch, or included); a base the hub doesn't hold (stale).
   */
  before(tab: string, gen: number, baseSeq: number, hash: string): SubmitAnswer | null {
    const op = `${tab}:${gen}`;
    let t = this.tabs.get(tab);
    if (!t) {
      const w = this.tombstones.get(tab);
      if (w === undefined) return { op, unknownTab: true };
      // (reactivated from its tombstone: its watermark, no acks; this submission not applied)
      this.tombstones.delete(tab);
      t = { watermark: w, acks: [], persistedGen: 0, lastSeen: this.deps.now() };
      this.tabs.set(tab, t);
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
    try { return this.submitWithin(this.tabs.get(tab)!, op, gen, this.heads.get(baseSeq)!, bytes, hash); } finally { this.res = null; res.close(); this.account(); }
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
    this.includedGens.set(tab, gen);
    this.newHead(r.records, "tab", r.reports, r.alternatives, made);
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
  connect(tab: string) { if (!this.tabs.has(tab) && !this.tombstones.has(tab)) this.tabs.set(tab, { watermark: 0, acks: [], persistedGen: 0, lastSeen: this.deps.now(), pin: this.H.seq }); }

  /** A tab released (disconnected): its accounting released, a tombstone of its watermark kept. */
  release(tab: string) {
    const t = this.tabs.get(tab);
    if (!t) return;
    this.tabs.delete(tab);
    this.tombstones.set(tab, t.watermark);
    while (this.tombstones.size > this.limits.TAB_TOMBSTONES) this.tombstones.delete(this.tombstones.keys().next().value!);
    this.account(); // (its pinned head released)
  }

  /** What a tab is told with each head: the highest gen of its ops in it, and its persistedGen. */
  tabView(tab: string) {
    const t = this.tabs.get(tab);
    return { includes: this.includedGens.get(tab) ?? 0, persistedGen: t?.persistedGen ?? 0 };
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
  async save(): Promise<WriteOutcome> {
    // (one write queue: a save asked for while one runs follows it, r7 §5.6)
    const run = (this.saving ?? Promise.resolve()).catch(() => {}).then(async () => {
      const T = this.H; // (the frozen tuple: its value, seq and bytes)
      this.writing = T;
      try { return await this.saveTuple(T); } finally { this.writing = null; this.account(); }
    });
    this.saving = run;
    try { return await run; } finally { if (this.saving === run) this.saving = null; }
  }
  private saving: Promise<WriteOutcome> | null = null;

  /** Whether anything is unsaved that a save could write now (the exit flush's test: no WRITE_MIN_MS, no quiet). */
  unsaved(): boolean {
    if (this.H.seq === this.P.seq) return false;
    return !(this.state.state === "held" && this.state.why !== "error" && this.state.why !== "slots");
  }

  private async saveTuple(T: Version): Promise<WriteOutcome> {
    const included = new Map(this.includedGens);
    this.lastWrite = this.deps.now();
    const before = this.P;
    const r = writeOnce(this.file, T.bytes, this.O, this.slots, { fs: this.deps.fs });
    if (r.saved) {
      this.P = T;
      this.O = T.hash;
      this.persistedSeq = T.seq;
      this.retainSave(T);
      for (const [tab, gen] of included) { const t = this.tabs.get(tab); if (t) t.persistedGen = Math.max(t.persistedGen, gen); }
      this.prevs.push({ path: r.prev, hash: hashOf(before.bytes), base: before, ingestedSeq: T.seq, quietSince: this.deps.now() });
      if (this.H.seq === T.seq) this.dirtySince = null;
      this.state = { state: "ok" };
      this.events.push({ seq: this.H.seq, persistedSeq: this.persistedSeq, reports: [], alternatives: [], source: "save" });
      return r;
    }
    switch (r.why) {
      case "changed": await this.observe(r.bytes); break;
      case "classified": {
        // (C, the bytes W4 read, is an observed version made from the P current at W2; prev retained, C its base)
        const p = { path: r.prev, hash: hashOf(r.bytes), base: before, ingestedSeq: Infinity, quietSince: this.deps.now() };
        this.prevs.push(p);
        const v = await this.observe(r.bytes, before);
        // (or, already seen at FILE: the version it was then)
        const seen = v ?? (this.observed?.raw === p.hash ? this.observed.version : this.P.hash === p.hash ? this.P : undefined);
        if (seen && this.state.state === "ok") { p.base = seen; p.ingestedSeq = this.H.seq; }
        break;
      }
      case "replaced":
        this.prevs.push({ path: r.prev, hash: before.hash, base: before, ingestedSeq: T.seq, quietSince: this.deps.now() });
        break;
      case "deleted": this.state = { state: "held", why: "deleted", detail: "FILE was deleted or moved" }; break;
      case "slots": this.state = { state: "held", why: "slots", detail: "too many copies kept beside FILE, waiting for them to settle" }; break;
      case "stuck": this.state = { state: "held", why: "stuck", detail: `FILE is missing: kept at ${r.kept.join(", ")}` }; break;
      case "eexist": this.state = { state: "held", why: "error", detail: `a new FILE appeared during the save; kept ${r.kept.join(", ")}` }; break;
      case "error": this.state = { state: "held", why: "error", detail: r.message }; break;
    }
    return r;
  }
}
