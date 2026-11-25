// `Course`: one Durable Object per course key (plan-lti-r5 §2.1, §3.4).  In
// stage A it holds only sessions, members' generations and the course's;
// stage C adds the roster, progress and scores.
//
// Rows are fixed width (charge errata r2): keys are 16 B blobs, and nothing
// from the LMS (deployment, context, sub) is kept here.  `rid` isn't stored,
// since every session in one Course has the same one.

import { DurableObject } from "cloudflare:workers";
import { contentRead } from "./content.ts";
import { CourseAgs, type ScoreInput } from "./course-ags.ts";
import { getPlacement, getRegistration, type D1 } from "./db.ts";
import type { Env } from "./env.ts";
import { hex, testMode } from "./util.ts";

export const RENEW_MS = 15 * 60_000;
export const LEARNER_ABS_MS = 8 * 3600_000;
export const INSTRUCTOR_ABS_MS = 3600_000;
export const MAX_SESSIONS = 20_000;
export const MAX_INSTRUCTOR_SESSIONS = 100;
export const MAX_MEMBERS = 5_000;
/** amendment 1 r6 §4.1 (r5 §15.3's line): erased tombstones, ≤ 5,000 a course, ≤ 64 B, kept 400 days */
export const MAX_ERASED = 5_000;
export const ERASED_KEEP_MS = 400 * 86_400_000;
// (a tombstone is never evicted early: 400 days is far longer than any continuation or session that can
// name its ref (≤ 8 h), so a full table refuses new erasures instead, fail closed; CORR-LTIMAP-1)
const SWEEP_ROWS = 1_000;

/** Role ranks, for the downgrade fence (§3.4): a guest has no session but still lowers. */
export type Role = "instructor" | "learner";
const RANK = { guest: 0, learner: 1, ta: 2, instructor: 3 } as const;
/** a session's rank, in its `kind` byte: amendment 5 r5 §1's TA sits between learner and a full instructor */
const rankOf = (role: Role, staff: "instructor" | "ta" | null): 1 | 2 | 3 => (role === "learner" ? 1 : staff === "ta" ? 2 : 3);

/** What a launch hands to a new session (§3.4).  Only the keys, role and times are kept. */
export interface SessionBinding {
  course: string;
  rid: string;
  deployment: string;
  context: string;
  placement: string | null;
  sub: string;
  member: string;
  /** the member_ref Reg issued for this launch; the session requires the member row holding exactly it (CORR-LTIMAP-1) */
  member_ref?: string;
  role: Role;
  /** amendment 5 r5 §1: for an instructor, a TA or a full instructor; null for a learner */
  staff: "instructor" | "ta" | null;
  launched_at: number;
}

export interface SessionView {
  course: string;
  placement: string | null;
  member: string;
  role: Role;
  staff: "instructor" | "ta" | null;
  sid: string;
  /** amendment 5 r5 §2: 128 random bits, unique in this Course, never derived from the sid; 32 hex */
  handle: string;
  expires: number;
  abs_end: number;
}

type Answer<T> = { ok: true; value: T } | { ok: false; code: string };

const KEY = /^[0-9a-f]{32}$/;
function key(s: string): Uint8Array | null {
  if (!KEY.test(s)) return null;
  return Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
}
const blobHex = (b: unknown): string => hex(new Uint8Array(b as ArrayBuffer));

export class LtiCourse extends DurableObject<Env> {
  private sql: SqlStorage;
  private ags: CourseAgs;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // (a store made before the fixed-width rows: its sessions are dropped, so their holders relaunch)
    const cols = [...this.sql.exec("SELECT name FROM pragma_table_info('sessions')")].map((c) => (c as { name: string }).name);
    const old = cols.length > 0 && (cols.includes("binding") || !cols.includes("handle"));
    if (old) this.sql.exec("DROP TABLE sessions; DROP TABLE IF EXISTS gens");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gens (who TEXT PRIMARY KEY CHECK (who = 'course'), gen INTEGER NOT NULL CHECK (gen BETWEEN 0 AND 2147483647));
      CREATE TABLE IF NOT EXISTS members (
        member BLOB PRIMARY KEY CHECK (length(member) = 16),
        gen INTEGER NOT NULL DEFAULT 0 CHECK (gen BETWEEN 0 AND 4294967295),
        fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
        member_ref BLOB UNIQUE CHECK (member_ref IS NULL OR length(member_ref) = 16),
        person_ref BLOB CHECK (person_ref IS NULL OR length(person_ref) = 16)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sessions (
        sid BLOB PRIMARY KEY CHECK (length(sid) = 16),
        placement BLOB CHECK (placement IS NULL OR length(placement) = 16),
        member BLOB NOT NULL CHECK (length(member) = 16),
        kind INTEGER NOT NULL CHECK (kind IN (1, 2, 3)),
        course_gen INTEGER NOT NULL CHECK (course_gen BETWEEN 0 AND 2147483647),
        member_gen INTEGER NOT NULL CHECK (member_gen BETWEEN 0 AND 2147483647),
        expires INTEGER NOT NULL,
        abs_end INTEGER NOT NULL,
        handle BLOB NOT NULL UNIQUE CHECK (length(handle) = 16)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS sessions_end ON sessions (abs_end);
      CREATE TABLE IF NOT EXISTS erased (member_ref BLOB PRIMARY KEY CHECK (length(member_ref) = 16), at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS erased_at ON erased (at);`);
    const reg = (rid: string) => env.LTI_REG!.get(env.LTI_REG!.idFromName(rid));
    this.ags = new CourseAgs(ctx, this.sql, {
      charge: (rid, qid, inc, course) => reg(rid).agsCharge(rid, qid, inc, course),
      release: (rid, qid, inc) => reg(rid).agsRelease(rid, qid, inc),
      call: (rid, p) => reg(rid).agsCall(rid, p),
      placement: (pl) => getPlacement(env.LTI_DB as D1, pl),
      registration: async (rid) => {
        const r = await getRegistration(env.LTI_DB as D1, rid);
        return r && r.policy && r.client_id ? { policy: r.policy, client_id: r.client_id, state: r.state } : null;
      },
      // (amendment 3 r15: assignments are LtiContent's; read only here)
      assignment: (aid) => (env.LTI_CONTENT ? contentRead(env).first<{ title: string; max_points: number }>("SELECT title, max_points FROM assignments WHERE aid = ?", aid) : Promise.resolve(null)),
      armAt: (at) => this.armAt(at),
      memberLive: (member, memberRef) => {
        const m = key(member), mr = key(memberRef);
        if (!m || !mr) return false;
        return [...this.sql.exec("SELECT 1 FROM members WHERE member = ? AND member_ref = ?", m, mr)].length === 1 && ![...this.sql.exec("SELECT 1 FROM erased WHERE member_ref = ?", mr)].length;
      },
    });
  }

  // ---- grades (§5.3, §14.2): queue one score change; the alarm drains the outbox
  async queueScore(course: string, s: ScoreInput) {
    return this.ags.queue(course, s);
  }
  /** (tests) one drain now, and the outbox's state */
  async agsDrain(): Promise<number> {
    return this.ags.drain();
  }
  agsInspect() {
    return this.ags.inspect();
  }
  agsTestDue() {
    this.ags.testDue();
  }
  /** (tests only) fill the AGS tables with maximum-width rows, and report the store's size */
  agsTestFill(a: Parameters<CourseAgs["testFill"]>[0]) {
    const r = this.ags.testFill(a);
    return { ...r, size: this.ctx.storage.sql.databaseSize };
  }
  /** (tests only) a member's handle */
  memberRefOf(member: string): string | null {
    if ((globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ !== true) return null;
    const m = key(member);
    const r = m && ([...this.sql.exec("SELECT member_ref FROM members WHERE member = ?", m)][0] as { member_ref: ArrayBuffer | null } | undefined);
    return r && r.member_ref ? blobHex(r.member_ref) : null;
  }

  private courseGen(): number {
    const r = [...this.sql.exec("SELECT gen FROM gens WHERE who = 'course'")][0] as { gen: number } | undefined;
    return r?.gen ?? 0;
  }

  /**
   * A member's row: `gen` packs the member generation (gen >> 2) and `top`, the
   * highest rank granted in this generation (gen & 3); `fence` packs the latest
   * launch below the highest rank, `at * 4 + rank`, the lowest rank winning at
   * one time.  At most MAX_MEMBERS rows.
   */
  private member(m: Uint8Array, create: boolean): { gen: number; top: number; lowAt: number; lowRank: number } | null {
    let r = [...this.sql.exec("SELECT gen, fence FROM members WHERE member = ?", m)][0] as { gen: number; fence: number } | undefined;
    if (!r) {
      if (!create) return { gen: 0, top: 0, lowAt: -1, lowRank: 0 };
      if ((this.sql.exec("SELECT count(*) AS n FROM members").one() as { n: number }).n >= MAX_MEMBERS) return null;
      this.sql.exec("INSERT INTO members (member) VALUES (?)", m);
      r = { gen: 0, fence: 0 };
    }
    return { gen: Math.floor(r.gen / 4), top: r.gen % 4, lowAt: r.fence === 0 ? -1 : Math.floor(r.fence / 4), lowRank: r.fence % 4 };
  }

  /**
   * A launch for `member` at `rank`, launched at `at` (§3.4 "a relaunch maps
   * the member to a lower role").  Synchronous: one storage transaction.
   *  - A launch older than (or as old as) the member's latest lower launch, at
   *    a higher rank than it, is stale: a delayed ticket can't restore what the
   *    newer launch took away (CORR-LTIA-1).
   *  - EVERY downward change, below the highest rank granted in the member's
   *    current generation, bumps the generation, so every session of the
   *    member ends at once: instructor to learner or guest, learner to guest.
   *  - Every launch below the top rank is recorded as the fence: the latest
   *    one, and at an equal time the lowest rank (the strongest fence).
   */
  private relaunch(m: Uint8Array, rank: number, at: number): Answer<{ memberGen: number }> {
    const cur = this.member(m, true);
    if (!cur) return { ok: false, code: "course_full" };
    if (cur.lowAt >= 0 && at <= cur.lowAt && rank > cur.lowRank) return { ok: false, code: "stale_launch" };
    let gen = cur.gen, top = cur.top;
    if (rank < top) {
      gen += 1;
      top = rank;
    } else top = rank;
    if (rank < RANK.instructor && (at > cur.lowAt || (at === cur.lowAt && rank < cur.lowRank)))
      this.sql.exec("UPDATE members SET fence = ? WHERE member = ?", at * 4 + rank, m);
    this.sql.exec("UPDATE members SET gen = ? WHERE member = ?", gen * 4 + top, m);
    return { ok: true, value: { memberGen: gen } };
  }

  /** A guest relaunch (no session): it lowers, as any lower-role relaunch does. */
  lower(member: string, at: number): Answer<null> {
    const m = key(member);
    if (!m) return { ok: false, code: "params" };
    const r = this.relaunch(m, RANK.guest, at);
    return r.ok ? { ok: true, value: null } : r;
  }

  /** A new session from a redeemed launch ticket.  The absolute end runs from the launch (§3.4). */
  create(b: SessionBinding): Answer<SessionView> {
    const now = Date.now();
    this.sweep(now);
    const m = key(b.member), p = b.placement === null ? null : key(b.placement);
    if (!m || (b.placement !== null && !p) || !KEY.test(b.course)) return { ok: false, code: "params" };
    const n = this.sql.exec("SELECT count(*) AS n, coalesce(sum(kind >= 2), 0) AS i FROM sessions").one() as { n: number; i: number };
    if (n.n >= MAX_SESSIONS || (b.role === "instructor" && n.i >= MAX_INSTRUCTOR_SESSIONS)) return { ok: false, code: "sessions_full" };
    const abs = b.launched_at + (b.role === "instructor" ? INSTRUCTOR_ABS_MS : LEARNER_ABS_MS);
    if (abs <= now) return { ok: false, code: "expired" };
    // the incarnation fence (CORR-LTIMAP-1): the member row must hold exactly the member_ref Reg issued for this
    // launch, and that ref must not be erased.  An erasure that ran while this launch was in flight removed the
    // row, or left a tombstone, so the continuation can't recreate the erased incarnation.
    if (b.member_ref !== undefined) {
      const mr = key(b.member_ref);
      if (!mr) return { ok: false, code: "params" };
      if ([...this.sql.exec("SELECT 1 FROM erased WHERE member_ref = ?", mr)].length) return { ok: false, code: "erased" };
      const row = [...this.sql.exec("SELECT member_ref FROM members WHERE member = ?", m)][0] as { member_ref: ArrayBuffer | null } | undefined;
      if (!row || row.member_ref === null || blobHex(row.member_ref) !== b.member_ref) return { ok: false, code: "erased" };
    }
    const staff = b.role === "instructor" ? (b.staff === "ta" ? "ta" : "instructor") : null;
    const kind = rankOf(b.role, staff);
    // the handle: random, so nothing about the sid is in it; drawn again on the (≈ 2^-128) collision, before anything is written
    let handle = crypto.getRandomValues(new Uint8Array(16));
    for (let i = 0; [...this.sql.exec("SELECT 1 FROM sessions WHERE handle = ?", handle)].length; i++) {
      if (i >= 3) return { ok: false, code: "handle" };
      handle = crypto.getRandomValues(new Uint8Array(16));
    }
    const r = this.relaunch(m, kind, b.launched_at);
    if (!r.ok) return r;
    const sid = crypto.getRandomValues(new Uint8Array(16));
    const expires = Math.min(now + RENEW_MS, abs);
    this.sql.exec(
      "INSERT INTO sessions (sid, placement, member, kind, course_gen, member_gen, expires, abs_end, handle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      sid, p, m, kind, this.courseGen(), r.value.memberGen, expires, abs, handle,
    );
    void this.arm();
    return { ok: true, value: { course: b.course, placement: b.placement, member: b.member, role: b.role, staff, sid: hex(sid), handle: hex(handle), expires, abs_end: abs } };
  }

  /** The live session `sid`, re-checking expiry and both generations, or refused. */
  check(sid: string): Answer<SessionView> {
    const s = key(sid);
    if (!s) return { ok: false, code: "session" };
    const now = Date.now();
    const r = [...this.sql.exec("SELECT * FROM sessions WHERE sid = ?", s)][0] as Record<string, unknown> | undefined;
    if (!r) return { ok: false, code: "session" };
    if ((r.expires as number) <= now) return { ok: false, code: "expired" };
    const mem = this.member(new Uint8Array(r.member as ArrayBuffer), false)!;
    if ((r.course_gen as number) !== this.courseGen() || (r.member_gen as number) !== mem.gen) return { ok: false, code: "revoked" };
    return {
      ok: true,
      value: {
        course: this.ctx.id.name ?? "",
        placement: r.placement === null ? null : blobHex(r.placement),
        member: blobHex(r.member),
        role: (r.kind as number) >= 2 ? "instructor" : "learner",
        staff: r.kind === 3 ? "instructor" : r.kind === 2 ? "ta" : null,
        sid,
        handle: blobHex(r.handle),
        expires: r.expires as number,
        abs_end: r.abs_end as number,
      },
    };
  }

  /** Renew for another 15 minutes, never past the absolute end; after it, only a relaunch (§3.4). */
  renew(sid: string): Answer<SessionView> {
    const c = this.check(sid);
    if (!c.ok) return c;
    const now = Date.now();
    if (c.value.abs_end <= now) return { ok: false, code: "expired" };
    const expires = Math.min(now + RENEW_MS, c.value.abs_end);
    this.sql.exec("UPDATE sessions SET expires = ? WHERE sid = ?", expires, key(sid)!);
    return { ok: true, value: { ...c.value, expires } };
  }

  /** Keep this course's copy of a member's handles, issued by Reg (amendment 1 r6 §2.4: a cache, never made here). */
  setMember(member: string, memberRef: string, personRef: string): Answer<null> {
    const m = key(member), mr = key(memberRef), pr = key(personRef);
    if (!m || !mr || !pr) return { ok: false, code: "params" };
    // an erased incarnation never comes back (amendment 1 §4.1; CORR-LTIMAP-1)
    if ([...this.sql.exec("SELECT 1 FROM erased WHERE member_ref = ?", mr)].length) return { ok: false, code: "erased" };
    const r = [...this.sql.exec("SELECT member_ref FROM members WHERE member = ?", m)][0] as { member_ref: ArrayBuffer | null } | undefined;
    if (r && r.member_ref !== null && blobHex(r.member_ref) !== memberRef) return { ok: false, code: "handle_mismatch" };
    if (!r) {
      if ((this.sql.exec("SELECT count(*) AS n FROM members").one() as { n: number }).n >= MAX_MEMBERS) return { ok: false, code: "course_full" };
      this.sql.exec("INSERT INTO members (member, member_ref, person_ref) VALUES (?, ?, ?)", m, mr, pr);
    } else if (r.member_ref === null) this.sql.exec("UPDATE members SET member_ref = ?, person_ref = ? WHERE member = ?", mr, pr, m);
    return { ok: true, value: null };
  }

  /**
   * Erase one member's data here (amendment 1 r6 §4.1 step 3).  Keyed by the
   * manifest's OLD random member_ref, never by the internal member key: only
   * the row holding exactly that handle is touched, and no such row answers
   * done.  person_ref is a second guard.  Stage A holds only sessions and the
   * member row; stages B–D add score state, outbox releases and the sync purge
   * here, each confirmed before `done`.
   */
  async eraseMember(memberRef: string, eraseId: string, personRef: string): Promise<Answer<null>> {
    void eraseId;
    const mr = key(memberRef);
    if (!mr) return { ok: false, code: "params" };
    const r = [...this.sql.exec("SELECT member, person_ref FROM members WHERE member_ref = ?", mr)][0] as { member: ArrayBuffer; person_ref: ArrayBuffer } | undefined;
    if (r && personRef && blobHex(r.person_ref) !== personRef) return { ok: false, code: "person_mismatch" };
    // the tombstone first, even with no row here (CORR-LTIMAP-1): a launch already past Reg's issue, whose
    // setMember or create arrives later, is refused
    const now = Date.now();
    if (![...this.sql.exec("SELECT 1 FROM erased WHERE member_ref = ?", mr)].length) {
      this.sql.exec("DELETE FROM erased WHERE member_ref IN (SELECT member_ref FROM erased WHERE at < ? ORDER BY at LIMIT 100)", now - ERASED_KEEP_MS);
      if ((this.sql.exec("SELECT count(*) AS n FROM erased").one() as { n: number }).n >= MAX_ERASED) return { ok: false, code: "erasure_busy" };
      this.sql.exec("INSERT INTO erased (member_ref, at) VALUES (?, ?)", mr, now);
    }
    if (!r) return { ok: true, value: null };
    const m = new Uint8Array(r.member);
    // every session of that member ends at once: deleted with the member row, in this transaction
    this.sql.exec("DELETE FROM sessions WHERE member = ?", m);
    // their score keys: dropped and released in Reg before the member row goes (retried by the job until done)
    if (!(await this.ags.eraseMember(blobHex(r.member)))) return { ok: false, code: "scores_pending" };
    this.sql.exec("DELETE FROM members WHERE member = ?", m);
    return { ok: true, value: null };
  }

  /** (tests) */
  erasedCount(): number {
    return (this.sql.exec("SELECT count(*) AS n FROM erased").one() as { n: number }).n;
  }

  /** (tests) */
  memberCount(): number {
    return (this.sql.exec("SELECT count(*) AS n FROM members WHERE member_ref IS NOT NULL").one() as { n: number }).n;
  }


  /** Bump a member's generation, or the course's: every matching session ends at once (§3.4). */
  bump(member: string | null): void {
    if (member === null) {
      this.sql.exec("INSERT INTO gens (who, gen) VALUES ('course', 1) ON CONFLICT (who) DO UPDATE SET gen = gen + 1");
      return;
    }
    const m = key(member);
    if (!m) return;
    // (a member without a row has no session to end; a bump never makes a row, so it can't fill the course)
    this.sql.exec("UPDATE members SET gen = ((gen >> 2) + 1) * 4 WHERE member = ?", m);
  }

  /** Expired sessions go by their absolute end, ≤ 1,000 rows a call, by the index. */
  private sweep(now: number): void {
    this.sql.exec("DELETE FROM sessions WHERE sid IN (SELECT sid FROM sessions WHERE abs_end <= ? ORDER BY abs_end LIMIT ?)", now, SWEEP_ROWS);
  }

  private async armAt(at: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  private async arm(): Promise<void> {
    const r = this.sql.exec("SELECT min(abs_end) AS t FROM sessions").one() as { t: number | null };
    if (r.t !== null) await this.armAt(r.t);
  }

  async alarm(): Promise<void> {
    this.sweep(Date.now());
    await this.arm();
    // (the drain re-arms for its own next due row)
    await this.ags.drain();
  }

  /** Tests only: fill to `n` sessions or members with maximum-width rows, and report the store's size. */
  testFill(a: { sessions?: number; members?: number; erased?: number; erasedAgeMs?: number }): { size: number; sessions: number; members: number; erased: number } {
    if (!testMode()) throw new Error("test only");
    const now = Date.now();
    for (let i = (this.sql.exec("SELECT count(*) AS n FROM erased").one() as { n: number }).n; i < (a.erased ?? 0); i++)
      this.sql.exec("INSERT INTO erased (member_ref, at) VALUES (?, ?)", crypto.getRandomValues(new Uint8Array(16)), now - (a.erasedAgeMs ?? 0));
    for (let i = (this.sql.exec("SELECT count(*) AS n FROM members").one() as { n: number }).n; i < (a.members ?? 0); i++)
      this.sql.exec("INSERT INTO members (member, gen, fence) VALUES (?, ?, ?)", crypto.getRandomValues(new Uint8Array(16)), 4294967295, 2 ** 43 - 1);
    for (let i = (this.sql.exec("SELECT count(*) AS n FROM sessions").one() as { n: number }).n; i < (a.sessions ?? 0); i++)
      this.sql.exec(
        "INSERT INTO sessions (sid, placement, member, kind, course_gen, member_gen, expires, abs_end, handle) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)",
        crypto.getRandomValues(new Uint8Array(16)), crypto.getRandomValues(new Uint8Array(16)), crypto.getRandomValues(new Uint8Array(16)),
        2147483647, 2147483647, now + LEARNER_ABS_MS, now + LEARNER_ABS_MS - Math.floor(Math.random() * 1e6), crypto.getRandomValues(new Uint8Array(16)),
      );
    return {
      size: this.ctx.storage.sql.databaseSize,
      sessions: (this.sql.exec("SELECT count(*) AS n FROM sessions").one() as { n: number }).n,
      members: (this.sql.exec("SELECT count(*) AS n FROM members").one() as { n: number }).n,
      erased: (this.sql.exec("SELECT count(*) AS n FROM erased").one() as { n: number }).n,
    };
  }
}
