// Assignment and Grade Services, the course side (plan-lti-r5 §5.2, §5.3,
// §15.2): per-(placement, sub) score state, ordered and server-timestamped;
// the outbox, holding only each key's newest update, charged against Reg's
// set and fenced by incarnation; and line items, made once per placement by
// query-then-POST.  All state is in the Course object's SQLite.

import type { Placement } from "./db.ts";
import type { Policy } from "./policy.ts";
import { derivedKey, randomHex, testGate, testMode } from "./util.ts";

const ACT = "'Initialized', 'Started', 'InProgress', 'Submitted', 'Completed'";
const GRD = "'FullyGraded', 'Pending', 'PendingManual', 'Failed', 'NotReady'";
/**
 * Fixed-width rows (LIMIT-PR9-2): keys are 32-hex, `sub` ≤ 255 B (LTI's bound), the enums are checked,
 * `last` is a short code, and nothing else is free text. Each table's row count is kept in `ags_tally`,
 * in the transaction of every insert and delete, and admission is checked against it before any write.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS score_state (qid TEXT PRIMARY KEY CHECK (length(qid) = 32), placement TEXT NOT NULL CHECK (length(placement) = 32), sub TEXT NOT NULL CHECK (length(CAST(sub AS BLOB)) BETWEEN 1 AND 255), member TEXT NOT NULL CHECK (length(member) = 32), seq INTEGER NOT NULL, ts INTEGER NOT NULL, score REAL NOT NULL, max REAL NOT NULL, activity TEXT NOT NULL CHECK (activity IN (${ACT})), grading TEXT NOT NULL CHECK (grading IN (${GRD})), source TEXT NOT NULL CHECK (source IN ('attempt', 'override', 'regrade', 'callback')), acked_seq INTEGER NOT NULL, inc INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS score_state_member ON score_state (member);
CREATE TABLE IF NOT EXISTS outbox (qid TEXT PRIMARY KEY CHECK (length(qid) = 32), inc INTEGER NOT NULL, seq INTEGER NOT NULL, st TEXT NOT NULL CHECK (st IN ('reserving', 'held', 'charged', 'releasing')), charged_inc INTEGER, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, last TEXT CHECK (last IS NULL OR length(last) <= 32)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS outbox_next ON outbox (next_at);
CREATE TABLE IF NOT EXISTS lineitems (placement TEXT PRIMARY KEY, url TEXT, creating TEXT, started INTEGER, posts INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, multiple INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS grant_missing (placement TEXT PRIMARY KEY, at_updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idem (day INTEGER NOT NULL, idem BLOB NOT NULL CHECK (length(idem) = 16), seq INTEGER NOT NULL, PRIMARY KEY (day, idem)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ags_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ags_tally (k TEXT PRIMARY KEY CHECK (k IN ('score', 'outbox', 'idem')), n INTEGER NOT NULL CHECK (n >= 0));
INSERT OR IGNORE INTO ags_tally (k, n) VALUES ('score', 0), ('outbox', 0), ('idem', 0);
`;

/**
 * The Course AGS allocations (r5 §15.3; charge errata r3 addendum 2): score state is charged a fixed
 * width inside the 36 MiB progress budget it shares with progress rows; the outbox ≤ 16,000 rows (8 MiB);
 * callback idempotency ≤ 30,000 rows (2.9 MiB).
 */
export const PROGRESS_BYTES = 36 * 1024 * 1024;
export const FIXED_CHARGE = 16_384;
export const SCORE_ROW_CHARGE = 704;
export const SCORE_ROWS = Math.floor((PROGRESS_BYTES - FIXED_CHARGE) / SCORE_ROW_CHARGE);
export const OUTBOX_ROWS = 16_000;
export const IDEM_ROWS = 30_000;
export const SOURCES = new Set(["attempt", "override", "regrade", "callback"]);

export const MAX_TRIES = 12;
export const DRAIN_ROWS = 20;
export const IDEM_MS = 30 * 86_400_000;
/** Callback idempotency is kept in daily buckets (r5 §15.3): a record of day d answers through day d + 30. */
export const IDEM_DAYS = 30;
const DAY_MS = 86_400_000;
const idemBlob = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
const POSTS_MAX = 3;
const LINEITEM_PAGES = 10;
const SCORE_TYPE = "application/vnd.ims.lis.v1.score+json";
const LINEITEM_TYPE = "application/vnd.ims.lis.v2.lineitem+json";
const CONTAINER_TYPE = "application/vnd.ims.lis.v2.lineitemcontainer+json";

export type Activity = "Initialized" | "Started" | "InProgress" | "Submitted" | "Completed";
export type Grading = "FullyGraded" | "Pending" | "PendingManual" | "Failed" | "NotReady";
/** A score change: `member_ref` is the issuing member incarnation, checked live at the final transaction (CORR-AGS-2). */
export interface ScoreInput { placement: string; sub: string; member: string; member_ref: string; score: number; max: number; activity: Activity; grading: Grading; comment?: string; source: string; idem?: string }
type R<T> = { ok: true; value: T } | { ok: false; code: string };
type Call = { status: number; body: string; link: string | null };

/** What the Course needs from outside: Reg (by rid), D1 lookups and its alarm. */
export interface AgsDeps {
  charge(rid: string, qid: string, inc: number, course: string): Promise<"ok" | "full" | "stale">;
  release(rid: string, qid: string, inc: number): Promise<"done">;
  call(rid: string, p: { policy: Policy; clientId: string; deployment: string; scopes: string[]; grant: string[]; method: "GET" | "POST"; url: string; body?: string; contentType?: string; accept: string; maxBytes: number }): Promise<R<Call>>;
  placement(placement: string): Promise<Placement | null>;
  registration(rid: string): Promise<{ policy: Policy; client_id: string; state: string } | null>;
  assignment(aid: string): Promise<{ title: string; max_points: number } | null>;
  armAt(ms: number): Promise<void>;
  /** Synchronous, inside the final transaction: is `member` this course's live member with exactly `memberRef`, and not erased? */
  memberLive(member: string, memberRef: string): boolean;
}

interface Row { qid: string; inc: number; seq: number; st: string; charged_inc: number | null; tries: number; next_at: number }
interface State { qid: string; placement: string; sub: string; seq: number; ts: number; score: number; max: number; activity: string; grading: string; acked_seq: number; inc: number }

const ACTIVITY = new Set(["Initialized", "Started", "InProgress", "Submitted", "Completed"]);
const GRADING = new Set(["FullyGraded", "Pending", "PendingManual", "Failed", "NotReady"]);
const one = <T>(c: SqlStorageCursor<Record<string, SqlStorageValue>>): T | undefined => [...c][0] as T | undefined;

/** The score URL: the line item's path plus `/scores`, keeping its query string (§5.2). */
export function scoreUrl(lineitem: string): string {
  const u = new URL(lineitem);
  u.pathname = u.pathname.replace(/\/$/, "") + "/scores";
  return u.toString();
}

/** Does a placement's grant allow passback at all (§5.2 "unavailable service")? */
export function passback(p: Placement): "lineitem" | "create" | null {
  const s = p.ags_scope ?? [];
  if (!s.includes("score")) return null;
  if (p.lineitem) return "lineitem";
  if (p.lineitems && s.includes("lineitem")) return "create";
  return null;
}

export class CourseAgs {
  private busy = new Set<string>();
  // one drain at a time: the alarm and any other caller interleave at awaits otherwise, and would step one row twice
  private draining: Promise<number> | null = null;
  private stepping = new Set<string>();
  constructor(private ctx: DurableObjectState, private sql: SqlStorage, private deps: AgsDeps) {
    sql.exec(SCHEMA);
  }

  private course(): string {
    const r = one<{ v: string }>(this.sql.exec("SELECT v FROM ags_meta WHERE k = 'course'"));
    if (!r) throw new Error("course unknown");
    return r.v;
  }
  bindCourse(course: string): void {
    const r = one<{ v: string }>(this.sql.exec("SELECT v FROM ags_meta WHERE k = 'course'"));
    if (!r) this.sql.exec("INSERT INTO ags_meta (k, v) VALUES ('course', ?)", course);
    else if (r.v !== course) throw new Error("course mismatch");
  }
  private row(qid: string): Row | undefined {
    return one<Row>(this.sql.exec("SELECT * FROM outbox WHERE qid = ?", qid));
  }
  private state(qid: string): State | undefined {
    return one<State>(this.sql.exec("SELECT * FROM score_state WHERE qid = ?", qid));
  }
  private n(k: "score" | "outbox" | "idem"): number {
    return (this.sql.exec("SELECT n FROM ags_tally WHERE k = ?", k).one() as { n: number }).n;
  }
  private tally(k: "score" | "outbox" | "idem", d: number): void {
    if (d) this.sql.exec("UPDATE ags_tally SET n = n + ? WHERE k = ?", d, k);
  }
  /** A live idem record's seq: one point seek per live day (the primary key is (day, idem)). */
  private idemSeq(idem: string, now: number): number | null {
    const today = Math.floor(now / DAY_MS), days = Array.from({ length: IDEM_DAYS + 1 }, (_, i) => today - i);
    const r = one<{ seq: number }>(this.sql.exec(`SELECT seq FROM idem WHERE day IN (${days.join(",")}) AND idem = ?`, idemBlob(idem)));
    return r ? r.seq : null;
  }
  /** Whole expired days go, ≤ `max` rows a call. */
  private expireIdem(now: number, max: number): void {
    const oldest = Math.floor(now / DAY_MS) - IDEM_DAYS;
    this.tally("idem", -[...this.sql.exec("DELETE FROM idem WHERE (day, idem) IN (SELECT day, idem FROM idem WHERE day < ? LIMIT ?) RETURNING 1", oldest, max)].length);
  }

  /**
   * §5.3 and §14.2: one change of a key's score.  The idem record, the score state and the outbox row
   * are one transaction; a repeated idem answers the first result with no new update.
   */
  async queue(course: string, s: ScoreInput): Promise<R<{ seq: number; repeat: boolean }>> {
    this.bindCourse(course);
    if (!(Number.isFinite(s.score) && Number.isFinite(s.max) && s.max >= 0 && s.max <= 100_000 && s.score >= 0 && s.score <= s.max * 10)) return { ok: false, code: "bad_score" };
    if (!ACTIVITY.has(s.activity) || !GRADING.has(s.grading) || !SOURCES.has(s.source) || s.comment !== undefined) return { ok: false, code: "bad_score" };
    if (typeof s.sub !== "string" || !s.sub.length || new TextEncoder().encode(s.sub).length > 255) return { ok: false, code: "bad_sub" };
    if (!/^[0-9a-f]{32}$/.test(s.placement) || !/^[0-9a-f]{32}$/.test(s.member) || !/^[0-9a-f]{32}$/.test(s.member_ref)) return { ok: false, code: "params" };
    if (s.idem !== undefined && !/^[0-9a-f]{32}$/.test(s.idem)) return { ok: false, code: "bad_idem" };
    if (s.idem) {
      const d = this.idemSeq(s.idem, Date.now());
      if (d !== null) return { ok: true, value: { seq: d, repeat: true } };
    }
    await testGate("ags_queue_placement");
    const p = await this.deps.placement(s.placement);
    if (!p || p.course !== course) return { ok: false, code: "placement" };
    // no claim, no score scope, or no line item to reach: no passback, and nothing is queued (§5.2)
    if (!passback(p)) return { ok: false, code: "no_passback" };
    const qid = await derivedKey("qid", course, s.placement, s.sub);
    const res = this.ctx.storage.transactionSync((): { seq: number; repeat: boolean } | { refused: string } => {
      // the issuing member incarnation, live and not erased, after every await (CORR-AGS-2)
      if (!this.deps.memberLive(s.member, s.member_ref)) return { refused: "member" };
      const now = Date.now();
      if (s.idem) {
        const d = this.idemSeq(s.idem, now);
        if (d !== null) return { seq: d, repeat: true };
      }
      const st = this.state(qid);
      const r = this.row(qid);
      // admission, before any write (LIMIT-PR9-2): a new key's score row, a new outbox row, a new idem row
      // (a live idem was answered above, so an idem here is always a new row; expired days go first)
      if (s.idem && this.n("idem") >= IDEM_ROWS) this.expireIdem(now, 1000);
      if (!st && this.n("score") >= SCORE_ROWS) return { refused: "course_full" };
      if (!r && this.n("outbox") >= OUTBOX_ROWS) return { refused: "course_full" };
      if (s.idem && this.n("idem") >= IDEM_ROWS) return { refused: "course_full" };
      const seq = (st?.seq ?? 0) + 1;
      const ts = Math.max(now, (st?.ts ?? 0) + 1);
      let inc = st?.inc ?? 0;
      if (!r || r.st === "releasing") {
        // a new incarnation: the key has no row, or its row is on its way out (§15.2)
        inc += 1;
        this.sql.exec("INSERT OR REPLACE INTO outbox (qid, inc, seq, st, charged_inc, tries, next_at, last) VALUES (?, ?, ?, 'reserving', NULL, 0, ?, NULL)", qid, inc, seq, now);
        if (!r) this.tally("outbox", 1);
      } else {
        // same incarnation: the newer update replaces the pending one, with no new charge
        this.sql.exec("UPDATE outbox SET seq = ?, tries = 0, next_at = ? WHERE qid = ?", seq, now, qid);
      }
      this.sql.exec(
        `INSERT INTO score_state (qid, placement, sub, member, seq, ts, score, max, activity, grading, source, acked_seq, inc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (qid) DO UPDATE SET seq = excluded.seq, ts = excluded.ts, score = excluded.score, max = excluded.max, activity = excluded.activity, grading = excluded.grading, source = excluded.source, inc = excluded.inc`,
        qid, s.placement, s.sub, s.member, seq, ts, s.score, s.max, s.activity, s.grading, s.source, inc,
      );
      if (!st) this.tally("score", 1);
      if (s.idem) {
        this.sql.exec("INSERT INTO idem (day, idem, seq) VALUES (?, ?, ?)", Math.floor(now / DAY_MS), idemBlob(s.idem), seq);
        this.tally("idem", 1);
      }
      return { seq, repeat: false };
    });
    if ("refused" in res) return { ok: false, code: res.refused };
    await this.deps.armAt(Date.now());
    return { ok: true, value: res };
  }

  /** One wake: up to DRAIN_ROWS due rows, each moved one step.  Answers how many rows remain. */
  async drain(): Promise<number> {
    while (this.draining) await this.draining.catch(() => 0);
    this.draining = this.drainOnce();
    try {
      return await this.draining;
    } finally {
      this.draining = null;
    }
  }

  private async drainOnce(): Promise<number> {
    const now = Date.now();
    this.expireIdem(now, 1000);
    const due = [...this.sql.exec("SELECT qid FROM outbox WHERE next_at <= ? ORDER BY next_at LIMIT ?", now, DRAIN_ROWS)] as { qid: string }[];
    for (const { qid } of due) await this.step(qid);
    const next = one<{ t: number | null }>(this.sql.exec("SELECT min(next_at) AS t FROM outbox"));
    if (next?.t != null) await this.deps.armAt(Math.max(next.t, Date.now() + 50));
    return (this.sql.exec("SELECT count(*) AS n FROM outbox").one() as { n: number }).n;
  }

  private later(qid: string, inc: number, ms: number, last: string): void {
    this.sql.exec("UPDATE outbox SET next_at = ?, last = ? WHERE qid = ? AND inc = ?", Date.now() + ms, last.slice(0, 32), qid, inc);
  }
  private backoff(tries: number): number {
    return Math.min(3600_000, 2000 * 2 ** Math.min(tries, 11));
  }

  /** One step of one row, by its state (§15.2's table and completion guards). */
  async step(qid: string): Promise<void> {
    // (one step of a key at a time: erasure steps rows outside the drain)
    if (this.stepping.has(qid)) return;
    this.stepping.add(qid);
    try {
      await this.stepOnce(qid);
    } finally {
      this.stepping.delete(qid);
    }
  }

  private async stepOnce(qid: string): Promise<void> {
    const r = this.row(qid);
    if (!r) return;
    const st = one<State>(this.sql.exec("SELECT * FROM score_state WHERE qid = ?", qid));
    if (!st) {
      // (a row without its key: only a crash mid-erasure leaves this; release it)
      this.sql.exec("UPDATE outbox SET st = 'releasing' WHERE qid = ? AND inc = ?", qid, r.inc);
    }
    await testGate("ags_step_placement");
    const p = st ? await this.deps.placement(st.placement) : null;
    const rid = p?.rid ?? one<{ v: string }>(this.sql.exec("SELECT v FROM ags_meta WHERE k = ?", "rid:" + qid))?.v;
    if (p) this.sql.exec("INSERT OR REPLACE INTO ags_meta (k, v) VALUES (?, ?)", "rid:" + qid, p.rid);
    if (!rid) {
      this.later(qid, r.inc, 3600_000, "no_rid");
      return;
    }
    const cur = this.row(qid)!;
    if (cur.st === "reserving" || cur.st === "held") {
      let a: "ok" | "full" | "stale";
      try {
        a = await this.deps.charge(rid, qid, cur.inc, this.course());
      } catch {
        this.later(qid, cur.inc, this.backoff(cur.tries), "charge_failed");
        return;
      }
      // a charge reply applies only to the same incarnation still in an admission state
      const now = this.row(qid);
      if (!now || now.inc !== cur.inc || (now.st !== "reserving" && now.st !== "held")) return;
      if (a === "ok") this.sql.exec("UPDATE outbox SET st = 'charged', charged_inc = inc, next_at = ? WHERE qid = ? AND inc = ?", Date.now(), qid, cur.inc);
      else if (a === "full") this.sql.exec("UPDATE outbox SET st = 'held', next_at = ?, last = 'full' WHERE qid = ? AND inc = ?", Date.now() + 60_000, qid, cur.inc);
      return;
    }
    if (cur.st === "releasing") {
      try {
        await this.deps.release(rid, qid, cur.inc);
      } catch {
        this.later(qid, cur.inc, this.backoff(cur.tries), "release_failed");
        return;
      }
      this.tally("outbox", -[...this.sql.exec("DELETE FROM outbox WHERE qid = ? AND inc = ? AND st = 'releasing' RETURNING 1", qid, cur.inc)].length);
      return;
    }
    // charged: send, only from a row charged at its own incarnation
    if (cur.charged_inc !== cur.inc || !st || !p) return;
    await this.send(rid, p, st, cur);
  }

  private dropRow(qid: string, inc: number, seq: number, why: string): void {
    // drop (given up): only the update that was tried; a newer one in the row is kept
    this.sql.exec("UPDATE outbox SET st = 'releasing', next_at = ?, last = ? WHERE qid = ? AND inc = ? AND seq = ? AND st IN ('reserving', 'held', 'charged')", Date.now(), why.slice(0, 32), qid, inc, seq);
  }

  private async grantMissing(p: Placement): Promise<boolean> {
    const g = one<{ at_updated: number }>(this.sql.exec("SELECT at_updated FROM grant_missing WHERE placement = ?", p.placement));
    if (!g) return false;
    if (g.at_updated === p.updated) return true;
    // a newer launch brought a grant: retries resume
    this.sql.exec("DELETE FROM grant_missing WHERE placement = ?", p.placement);
    return false;
  }

  private async send(rid: string, p: Placement, st: State, row: Row): Promise<void> {
    if (await this.grantMissing(p)) {
      this.later(row.qid, row.inc, 3600_000, "grant_missing");
      return;
    }
    const reg = await this.deps.registration(rid);
    if (!reg || reg.state !== "approved") {
      this.later(row.qid, row.inc, 3600_000, "registration");
      return;
    }
    const li = await this.lineItem(rid, p, reg, st.max);
    if (li === "wait") {
      this.later(row.qid, row.inc, this.backoff(row.tries), "lineitem_wait");
      this.sql.exec("UPDATE outbox SET tries = tries + 1 WHERE qid = ? AND inc = ?", row.qid, row.inc);
      return;
    }
    if (li === "missing") return void this.markMissing(p, row);
    if (li === null) return this.dropRow(row.qid, row.inc, row.seq, "no_lineitem");
    // one coherent snapshot after every await (CORR-AGS-1): the outbox row still this charged incarnation,
    // holding exactly the score state's newest seq; that version is serialized, and only it is acked
    const now = this.row(row.qid);
    const cur = this.state(row.qid);
    if (!now || !cur || now.inc !== row.inc || now.st !== "charged" || now.charged_inc !== now.inc || now.seq !== cur.seq || cur.seq <= cur.acked_seq) return;
    row = now;
    const body = JSON.stringify({
      userId: cur.sub, scoreGiven: cur.score, scoreMaximum: cur.max, activityProgress: cur.activity, gradingProgress: cur.grading,
      timestamp: new Date(cur.ts).toISOString(),
    });
    const seq = cur.seq;
    const r = await this.deps.call(rid, { policy: reg.policy, clientId: reg.client_id, deployment: p.deployment, scopes: ["score"], grant: p.ags_scope ?? [], method: "POST", url: scoreUrl(li), body, contentType: SCORE_TYPE, accept: "application/json", maxBytes: 16 * 1024 });
    if (!r.ok) {
      // rate, a token failure or a transport failure: uncertain, so the same update is resent later
      if (r.code === "scope_not_granted") return void this.markMissing(p, row);
      return this.retry(row, r.code);
    }
    const s = r.value.status;
    if (s >= 200 && s < 300) return this.ack(row.qid, seq);
    if (s === 401 || s === 403) return void this.markMissing(p, row);
    if (s === 429 || s >= 500) return this.retry(row, `status_${s}`);
    this.dropRow(row.qid, row.inc, seq, `status_${s}`);
  }

  private retry(row: Row, why: string): void {
    if (row.tries + 1 >= MAX_TRIES) return this.dropRow(row.qid, row.inc, row.seq, why);
    this.sql.exec("UPDATE outbox SET tries = tries + 1, next_at = ?, last = ? WHERE qid = ? AND inc = ? AND seq = ?", Date.now() + this.backoff(row.tries), why.slice(0, 32), row.qid, row.inc, row.seq);
  }

  /** A second 401 or any 403: the grant is missing until a new launch brings one (§5.2). */
  private markMissing(p: Placement, row: Row): void {
    this.sql.exec("INSERT OR REPLACE INTO grant_missing (placement, at_updated) VALUES (?, ?)", p.placement, p.updated ?? 0);
    this.later(row.qid, row.inc, 3600_000, "grant_missing");
  }

  /** §5.3: an ack for `seq` — acked_seq rises; the row is released only if it still holds exactly that seq. */
  ack(qid: string, seq: number): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE score_state SET acked_seq = max(acked_seq, ?) WHERE qid = ?", seq, qid);
      this.sql.exec("UPDATE outbox SET st = 'releasing', next_at = ?, last = 'acked' WHERE qid = ? AND seq = ? AND st = 'charged'", Date.now(), qid, seq);
    });
  }

  /**
   * The placement's line item (§5.2): the launch's own, or one made here, serialized per placement.
   * Answers its URL, "wait" (uncertain, or another creation in flight), "missing" (the grant), or null
   * (no column can be made).
   */
  private async lineItem(rid: string, p: Placement, reg: { policy: Policy; client_id: string }, max: number): Promise<string | null | "wait" | "missing"> {
    if (p.lineitem) return p.lineitem;
    const mode = passback(p);
    if (mode !== "create") return null;
    const li = one<{ url: string | null; creating: string | null; posts: number; failed: number }>(this.sql.exec("SELECT url, creating, posts, failed FROM lineitems WHERE placement = ?", p.placement));
    if (li?.url) return li.url;
    if (li?.failed) return null;
    if (this.busy.has(p.placement)) return "wait";
    this.busy.add(p.placement);
    try {
      // 1. record the attempt durably, first
      const attempt = randomHex(8);
      this.sql.exec("INSERT INTO lineitems (placement, creating, started) VALUES (?, ?, ?) ON CONFLICT (placement) DO UPDATE SET creating = excluded.creating, started = excluded.started", p.placement, attempt, Date.now());
      const tag = p.placement.slice(0, 16);
      const base = { policy: reg.policy, clientId: reg.client_id, deployment: p.deployment, grant: p.ags_scope ?? [] };
      // 2. query first: an earlier, uncertain POST may have made it
      const q = new URL(p.lineitems!);
      q.searchParams.set("resource_link_id", p.resource_link);
      if (p.aid) q.searchParams.set("resource_id", p.aid);
      q.searchParams.set("tag", tag);
      const found: { id: string }[] = [];
      let next: string | null = q.toString();
      for (let page = 0; next && page < LINEITEM_PAGES; page++) {
        const r = await this.deps.call(rid, { ...base, scopes: ["lineitem"], method: "GET", url: next, accept: CONTAINER_TYPE, maxBytes: 256 * 1024 });
        if (!r.ok) return r.code === "scope_not_granted" ? "missing" : "wait";
        if (r.value.status === 401 || r.value.status === 403) return "missing";
        if (r.value.status !== 200) return "wait";
        let items: unknown;
        try {
          items = JSON.parse(r.value.body);
        } catch {
          return "wait";
        }
        if (!Array.isArray(items)) return "wait";
        for (const it of items as Record<string, unknown>[])
          if (it && typeof it.id === "string" && it.tag === tag && (it.resourceLinkId === undefined || it.resourceLinkId === p.resource_link)) found.push({ id: it.id });
        next = nextLink(r.value.link);
      }
      if (next) return "wait"; // (more pages than the bound: never POST on a partial answer)
      if (found.length) {
        // exactly one is adopted; with several carrying our tag, the oldest, and the instructor is told
        const pick = oldest(found);
        this.sql.exec("UPDATE lineitems SET url = ?, creating = NULL, multiple = ? WHERE placement = ? AND creating = ?", pick, found.length > 1 ? 1 : 0, p.placement, attempt);
        return pick;
      }
      // 3. no match: a POST, at most 3 in all
      const n = one<{ posts: number }>(this.sql.exec("SELECT posts FROM lineitems WHERE placement = ?", p.placement))!.posts;
      if (n >= POSTS_MAX) {
        this.sql.exec("UPDATE lineitems SET failed = 1, creating = NULL WHERE placement = ?", p.placement);
        return null;
      }
      this.sql.exec("UPDATE lineitems SET posts = posts + 1 WHERE placement = ?", p.placement);
      const a = p.aid ? await this.deps.assignment(p.aid) : null;
      const body = JSON.stringify({ scoreMaximum: a?.max_points ?? max, label: (a?.title ?? "Sagebrush assignment").slice(0, 255), resourceLinkId: p.resource_link, ...(p.aid ? { resourceId: p.aid } : {}), tag });
      const r = await this.deps.call(rid, { ...base, scopes: ["lineitem"], method: "POST", url: p.lineitems!, body, contentType: LINEITEM_TYPE, accept: LINEITEM_TYPE, maxBytes: 16 * 1024 });
      if (!r.ok) return r.code === "scope_not_granted" ? "missing" : "wait";
      if (r.value.status === 401 || r.value.status === 403) return "missing";
      if (r.value.status !== 200 && r.value.status !== 201) return "wait"; // uncertain: the next try queries first
      let id: unknown;
      try {
        id = (JSON.parse(r.value.body) as { id?: unknown }).id;
      } catch {
        return "wait";
      }
      if (typeof id !== "string" || id.length > 400) return "wait";
      // 4. a clear answer: the URL, in the same write that clears `creating`
      this.sql.exec("UPDATE lineitems SET url = ?, creating = NULL WHERE placement = ? AND creating = ?", id, p.placement, attempt);
      return id;
    } finally {
      this.busy.delete(p.placement);
    }
  }

  /** Erasure (amendment 1 r6 §4.1 step 3): a member's keys are dropped and released; done only when none remain. */
  async eraseMember(member: string): Promise<boolean> {
    const keys = [...this.sql.exec("SELECT qid FROM score_state WHERE member = ?", member)] as { qid: string }[];
    for (const { qid } of keys) {
      const r = this.row(qid);
      if (r && r.st !== "releasing") this.sql.exec("UPDATE outbox SET st = 'releasing', next_at = 0, last = 'erased' WHERE qid = ? AND inc = ?", qid, r.inc);
      if (r) await this.step(qid);
      if (!this.row(qid)) this.tally("score", -[...this.sql.exec("DELETE FROM score_state WHERE qid = ? RETURNING 1", qid)].length);
    }
    return (this.sql.exec("SELECT count(*) AS n FROM score_state WHERE member = ?", member).one() as { n: number }).n === 0;
  }

  /**
   * Tests only: fill score state, outbox and idem to the given counts with maximum-width rows (as the
   * tallies count them), for the cap and composition fixtures.
   */
  testFill(a: { score?: number; outbox?: number; idem?: number; idemExpired?: boolean; clearIdem?: boolean }): { score: number; outbox: number; idem: number } {
    if (!testMode()) throw new Error("test only");
    if (a.clearIdem) this.tally("idem", -[...this.sql.exec("DELETE FROM idem RETURNING 1")].length);
    const big = Number.MAX_SAFE_INTEGER, h = () => randomHex(16), now = Date.now();
    for (let i = this.n("score"); i < (a.score ?? 0); i++) {
      this.sql.exec("INSERT INTO score_state (qid, placement, sub, member, seq, ts, score, max, activity, grading, source, acked_seq, inc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Initialized', 'PendingManual', 'override', ?, ?)", h(), h(), "\u20ac".repeat(85), h(), big, big, Math.PI * 1e5, Math.PI * 1e4, big, big);
      this.tally("score", 1);
    }
    for (let i = this.n("outbox"); i < (a.outbox ?? 0); i++) {
      this.sql.exec("INSERT INTO outbox (qid, inc, seq, st, charged_inc, tries, next_at, last) VALUES (?, ?, ?, 'releasing', ?, ?, ?, ?)", h(), big, big, big, big, big - i, "x".repeat(32));
      this.tally("outbox", 1);
    }
    for (let i = this.n("idem"); i < (a.idem ?? 0); i++) {
      this.sql.exec("INSERT INTO idem (day, idem, seq) VALUES (?, ?, ?)", a.idemExpired ? Math.floor(now / DAY_MS) - IDEM_DAYS - 1 : Math.floor(now / DAY_MS), idemBlob(h()), big);
      this.tally("idem", 1);
    }
    return { score: this.n("score"), outbox: this.n("outbox"), idem: this.n("idem") };
  }

  /** (tests only) make every row due now */
  testDue(): void {
    if ((globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ !== true) return;
    this.sql.exec("UPDATE outbox SET next_at = 0");
  }

  /** (tests) */
  inspect(): { outbox: Row[]; state: State[]; lineitems: unknown[] } {
    return {
      outbox: [...this.sql.exec("SELECT * FROM outbox")] as unknown as Row[],
      state: [...this.sql.exec("SELECT * FROM score_state")] as unknown as State[],
      lineitems: [...this.sql.exec("SELECT * FROM lineitems")],
    };
  }
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** The oldest of several matching line items: by a numeric trailing id where all have one, else the first listed. */
function oldest(items: { id: string }[]): string {
  const num = items.map((i) => /(\d+)\/?$/.exec(i.id)?.[1]);
  if (num.every((n) => n !== undefined)) return items[num.map(Number).indexOf(Math.min(...num.map(Number)))].id;
  return items[0].id;
}
