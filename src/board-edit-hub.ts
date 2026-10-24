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
import { editRecords, fromEditRecords, roundTrips, givePageIds, serialize, bytesAre } from "../web/board/lossless";
import { writeOnce, Slots, hashOf, type WriteFs, type WriteOutcome } from "./board-edit-write";
import type { Limits } from "./board-edit-limits";

export interface Version { seq: number; records: Rec[]; json: any; bytes: Buffer; hash: string }
export type HubReport = MergeReport | { kind: "older-copy"; key: string; field: string; value: unknown; board: unknown };
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

interface TabRecord { watermark: number; acks: { gen: number; seq: number; hash: string }[]; persistedGen: number; lastSeen: number }

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
  prevs: { path: string; hash: string; base: Version; ingestedSeq: number; quietSince: number }[] = [];
  events: HeadEvent[] = [];

  constructor(readonly file: string, readonly limits: Limits, private deps: HubDeps) {
    this.slots = new Slots(limits.BACKUPS_MAX);
  }

  /** The hub on FILE's bytes as found (P₀), or why the board can't be edited. */
  async start(bytes: Buffer): Promise<{ ok: true } | { ok: false; why: string }> {
    const v = await this.version(bytes);
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
    return { version: { seq: ++this.seq, records, json: g.doc, bytes: g.given.length ? out : bytes, hash: hashOf(g.given.length ? out : bytes) }, given: g.given.length > 0 };
  }

  private remember(v: Version) {
    this.heads.set(v.seq, v);
    // (heads still referenced: H, P and the retained saves; the window bounded by HISTORY_PATCHES)
    const keep = new Set([this.H?.seq, this.P?.seq, ...this.saves.map((s) => s.seq)]);
    const seqs = [...this.heads.keys()].sort((a, b) => a - b);
    while (seqs.length > this.limits.HISTORY_PATCHES) { const s = seqs.shift()!; if (!keep.has(s)) this.heads.delete(s); }
  }

  private merge(base: Rec[], a: Rec[], b: Rec[]) {
    return boardMerge3(base, a, b, { mergeStrings3: this.deps.mergeStrings3, work: this.limits.MERGE_WORK, deadline: this.deps.now() + this.limits.MERGE_MS, now: this.deps.now });
  }

  private newHead(records: Rec[], source: HeadEvent["source"], reports: HubReport[], alternatives: MergeAlternative[]): Version {
    const json = fromEditRecords(records);
    const bytes = Buffer.from(serialize(json), "utf8");
    const v: Version = { seq: ++this.seq, records, json, bytes, hash: hashOf(bytes) };
    this.H = v;
    this.remember(v);
    this.events.push({ seq: v.seq, persistedSeq: this.persistedSeq, reports: reports.slice(0, this.limits.CONFLICTS_MAX), alternatives: alternatives.slice(0, this.limits.CONFLICTS_MAX), source });
    return v;
  }

  private dirty() { if (this.dirtySince === null) this.dirtySince = this.deps.now(); }

  /** An outside version seen at FILE (null: FILE absent). */
  async observe(bytes: Buffer | null, base: Version = this.P): Promise<void> {
    if (bytes === null) { this.state = { state: "held", why: "deleted", detail: "FILE was deleted or moved" }; return; }
    const h = hashOf(bytes);
    if (h === this.O || h === this.P.hash) { this.O = h; return; }
    this.O = h;
    const v = await this.version(bytes);
    if ("why" in v) { this.state = { state: "held", why: "invalid", detail: v.why }; return; }
    const C = v.version;
    const r = this.merge(base.records, this.H.records, C.records);
    if ("refused" in r) { this.state = { state: "held", why: "unmergeable", detail: `can't merge (${r.refused})` }; return; }
    this.state = { state: "ok" };
    const reports: HubReport[] = [...r.reports, ...this.olderCopy(C.records)];
    const head = this.newHead(r.records, "outside", reports, r.alternatives);
    if (canon(head.records) === canon(C.records)) {
      // (the file already holds the board's state: adopted as the latest save, nothing written)
      this.P = head;
      this.persistedSeq = head.seq;
      this.retainSave(head);
    } else this.dirty();
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
  /** A tab's submission: its snapshot (records, JSON lines) made from the head it adopted last (baseSeq). */
  submit(tab: string, gen: number, baseSeq: number, snapshot: string, hash: string): SubmitAnswer {
    const op = `${tab}:${gen}`;
    if (sha(snapshot) !== hash) return { op, refused: "the snapshot's hash doesn't match" };
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
    const base = this.heads.get(baseSeq);
    if (!base) return { op, stale: true, seq: this.H.seq };
    let records: Rec[];
    try { records = snapshot.split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return { op, refused: "the snapshot isn't JSON lines" }; }
    if (records.length > this.limits.RECORDS_MAX) return { op, refused: `more than RECORDS_MAX (${this.limits.RECORDS_MAX}) records` };
    // (its bytes as written must be the board it says: the lossless check)
    const json = fromEditRecords(records);
    if (!bytesAre(serialize(json), json).ok) return { op, refused: "the snapshot can't be written without losing something" };
    const r = this.merge(base.records, this.H.records, records);
    if ("refused" in r) return { op, refused: `can't merge (${r.refused})` };
    this.includedGens.set(tab, gen);
    this.newHead(r.records, "tab", r.reports, r.alternatives);
    t.watermark = gen;
    t.acks.push({ gen, seq: this.H.seq, hash });
    while (t.acks.length > this.limits.ACKS_KEPT) t.acks.shift();
    this.dirty();
    return { op, accepted: true, seq: this.H.seq };
  }

  /** A tab connected (its record made, if new). */
  connect(tab: string) { if (!this.tabs.has(tab) && !this.tombstones.has(tab)) this.tabs.set(tab, { watermark: 0, acks: [], persistedGen: 0, lastSeen: this.deps.now() }); }

  /** A tab released (disconnected): its accounting released, a tombstone of its watermark kept. */
  release(tab: string) {
    const t = this.tabs.get(tab);
    if (!t) return;
    this.tabs.delete(tab);
    this.tombstones.set(tab, t.watermark);
    while (this.tombstones.size > this.limits.TAB_TOMBSTONES) this.tombstones.delete(this.tombstones.keys().next().value!);
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
    const T = this.H; // (the frozen tuple: its value, seq and bytes)
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
      case "classified":
        // (C, the bytes W4 read, is an observed version made from the P current at W2; prev retained)
        this.prevs.push({ path: r.prev, hash: hashOf(r.bytes), base: before, ingestedSeq: Infinity, quietSince: this.deps.now() });
        await this.observe(r.bytes, before);
        break;
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
