// The Gradebook: one Durable Object per placement (grading G1 r5 §3), named by the placement
// key, SQLite-backed, bound in the LTI Worker as GRADEBOOK. It records each final collection
// that `Course` delivers, and the rebuild state of `failed_resource` collections (§4.1). It
// never reads a document's content (G1's no-server-parse rule): everything it stores is a
// field of the wire (cji.ts).
//
// Course is the only caller. The envelope's `course_epoch` is the only epoch it trusts;
// `teardown(E, purge_id)` fences everything below E (§3.6).

import { DurableObject } from "cloudflare:workers";
import {
  type Answer,
  type CJI,
  canonical,
  COLLECTION_REASONS,
  FAILURE_REASONS,
  OUTCOMES,
  type Rebuilt,
  type Triple,
  validateCJI,
  validateEnvelope,
  validateRebuilt,
  WireError,
} from "./cji.ts";
import {
  G2,
  G2_LIMITS,
  G2_SCHEMA,
  type GradeKey,
  type GradingAnswer,
  type GradingEnvelope,
  newSecret,
  parseChoiceRequest,
  parseGradeRequest,
  parseQuestionId,
  parseRubricRequest,
  parseSpecQuestions,
  OUTCOMES as SPEC_OUTCOMES,
  type SpecOutcome,
  parseUngradeRequest,
  Refusal,
  SETTINGS_INSERT,
  validateGradingEnvelope,
} from "./grades.ts";
import { memberHandle } from "./marks.ts";

export type TeardownAnswer = { more: true } | { done: true } | { stale: true };

// ---------------------------------------------------------------------------
// Limits (G1 r5 §6): admin-configurable integers in [minimum, ceiling]; anything else, or a
// malformed stored value, fails closed to the default.

export interface LimitSpec {
  default: number;
  min: number;
  max: number;
}

const MiB = 1024 * 1024;
export const GRADEBOOK_LIMITS: Record<string, LimitSpec> = {
  "grading.members_per_placement": { default: 5_000, min: 1, max: 20_000 },
  "grading.collections_per_member": { default: 8, min: 1, max: 32 },
  "grading.gradebook_bytes": { default: 128 * MiB, min: 1 * MiB, max: 2048 * MiB },
  ...G2_LIMITS, // (G2 r4 §6: the same record, separate budgets)
};

export function effectiveLimits(values: unknown): Record<string, number> {
  const src = values !== null && typeof values === "object" ? (values as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [k, s] of Object.entries(GRADEBOOK_LIMITS)) {
    const v = src[k];
    out[k] = Number.isSafeInteger(v) && (v as number) >= s.min && (v as number) <= s.max ? (v as number) : s.default;
  }
  return out;
}

// Physical charges per row (§3.1), proven by the gradebook-size fixture.
export const CHARGE = { collection: 1024, rebuild: 1024, member: 256 } as const;

// Teardown (§3.6): pages of ≤ 1,000 rows; ≤ 4 page transactions and ≤ 16 statements a call.
export const TEARDOWN_PAGE_ROWS = 1000;
export const TEARDOWN_TXNS_PER_CALL = 4;
export const RETRY_AFTER_MS = 1000;

const REBUILD = { open: 0, built: 1, conflict: 2 } as const;

const fromHex = (h: string): Uint8Array => {
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return b;
};
export const toHex = (b: ArrayBuffer | Uint8Array | null | undefined): string | null =>
  b == null ? null : [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  cid TEXT PRIMARY KEY, member TEXT NOT NULL, n INTEGER NOT NULL, creason INTEGER NOT NULL,
  drev INTEGER NOT NULL, xrev INTEGER NOT NULL, d INTEGER NOT NULL,
  at_seq INTEGER NOT NULL, chain BLOB NOT NULL, frozen_head INTEGER NOT NULL, late INTEGER NOT NULL,
  outcome INTEGER NOT NULL, reason INTEGER,
  value_sha256 BLOB, census_sha256 BLOB, outputs_digest BLOB,
  aid TEXT NOT NULL, assignment_rev INTEGER NOT NULL, bundle_sha BLOB NOT NULL,
  cji_sha BLOB NOT NULL, course_epoch INTEGER NOT NULL, recv_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collections_member ON collections (member, d DESC, n DESC);
CREATE INDEX IF NOT EXISTS collections_epoch ON collections (course_epoch, cid);
-- (G2 addendum A1 r5: spec_put's and spec_outcome's prerequisite, "a collection has this
-- bundle_sha", as an index seek: daybreak3's LIMIT-CLOUD14-1; covered by the 1,024 B row charge,
-- which the gradebook-size fixture proves with this index)
CREATE INDEX IF NOT EXISTS collections_bundle ON collections (bundle_sha);
-- (a member's collection count is an indexed count on collections_member, at most
-- collections_per_member rows read; so a teardown page needs no per-member counter update)
-- (G2 r4 §0.1: each member's anonymity handle, HMAC(settings.secret, member) truncated to 16 B,
-- written in the transaction that inserts the row; the row's charge stays 256 B)
CREATE TABLE IF NOT EXISTS members (member TEXT PRIMARY KEY, handle BLOB) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rebuilds (
  cid TEXT PRIMARY KEY, state INTEGER NOT NULL,
  v1 BLOB, c1 BLOB, o1 BLOB, v2 BLOB, c2 BLOB, o2 BLOB,
  course_epoch INTEGER NOT NULL, at_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS rebuilds_epoch ON rebuilds (course_epoch, cid);
CREATE TABLE IF NOT EXISTS state (
  k INTEGER PRIMARY KEY CHECK (k = 0),
  members_count INTEGER NOT NULL, charged_bytes INTEGER NOT NULL, epoch_floor INTEGER NOT NULL,
  t_purge_id TEXT, t_e INTEGER, t_step TEXT, t_key_epoch INTEGER, t_key_cid TEXT,
  limits_version INTEGER NOT NULL, limits TEXT NOT NULL
);
INSERT OR IGNORE INTO state (k, members_count, charged_bytes, epoch_floor, limits_version, limits)
  VALUES (0, 0, 0, 0, -1, '{}');
`;

interface State {
  members_count: number;
  charged_bytes: number;
  epoch_floor: number;
  t_purge_id: string | null;
  t_e: number | null;
  t_step: string | null;
  t_key_epoch: number | null;
  t_key_cid: string | null;
  limits_version: number;
  limits: string;
}

type Cursor = { step: string; e: number; ke: number; kc: string };

const invalid = (reason: string): Answer => ({ invalid: { reason } });

export class Gradebook extends DurableObject {
  private sql: SqlStorage;
  // (every SQL statement goes through exec(), the instrumented wrapper §3.6's tests count)
  protected statements = 0;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      // (a members table from before G2 gains the handle column; its rows get theirs below)
      const cols = this.sql.exec("PRAGMA table_info(members)").toArray() as { name: string }[];
      if (!cols.some((c) => c.name === "handle")) this.sql.exec("ALTER TABLE members ADD COLUMN handle BLOB");
      this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS members_handle ON members (handle)");
      this.sql.exec(G2_SCHEMA);
      this.sql.exec(SETTINGS_INSERT, newSecret());
      const secret = this.secret();
      const missing = this.sql.exec("SELECT member FROM members WHERE handle IS NULL").toArray() as { member: string }[];
      for (const m of missing) this.sql.exec("UPDATE members SET handle = ? WHERE member = ?", await memberHandle(secret, m.member), m.member);
    });
  }

  private secret(): Uint8Array {
    return new Uint8Array((this.sql.exec("SELECT secret FROM settings WHERE k = 0").one() as { secret: ArrayBuffer }).secret);
  }

  protected exec(query: string, ...args: unknown[]) {
    this.statements++;
    return this.sql.exec(query, ...args);
  }

  private state(): State {
    return this.exec("SELECT * FROM state WHERE k = 0").one() as unknown as State;
  }

  private limits(s: State): Record<string, number> {
    try {
      return effectiveLimits(JSON.parse(s.limits));
    } catch {
      return effectiveLimits(undefined); // (a malformed stored value fails closed to the defaults)
    }
  }

  // The effective limits, from Course on each `limits` version change (§6.1).
  configure(version: number, values: unknown): { version: number; limits: Record<string, number> } {
    const eff = effectiveLimits(values);
    return this.ctx.storage.transactionSync(() => {
      const s = this.state();
      if (Number.isSafeInteger(version) && version > s.limits_version)
        this.exec("UPDATE state SET limits_version = ?, limits = ? WHERE k = 0", version, JSON.stringify(eff));
      const now = this.state();
      return { version: now.limits_version, limits: this.limits(now) };
    });
  }

  // collection_sealed (§3.2): one transaction per new cid; the answer only after the commit.
  async collectionSealed(envelope: unknown, raw: unknown): Promise<Answer> {
    let env: { course_epoch: number };
    let cji: CJI;
    try {
      env = validateEnvelope(envelope);
      cji = validateCJI(raw);
    } catch (e) {
      if (e instanceof WireError) return invalid(e.code);
      throw e;
    }
    // (the frozen CJI's identity: a duplicate must match it on every field, r9 §6.7.5)
    const cjiSha = await sha256(canonical(cji));
    // (the member's handle, computed before the transaction, which re-checks the secret it used)
    this.exec(SETTINGS_INSERT, newSecret());
    const secret = this.secret();
    const handle = await memberHandle(secret, cji.member);
    return this.ctx.storage.transactionSync((): Answer => {
      const s = this.state();
      if (env.course_epoch < s.epoch_floor) return { purged: true };
      const old = this.exec("SELECT cji_sha FROM collections WHERE cid = ?", cji.cid).toArray()[0] as
        | { cji_sha: ArrayBuffer }
        | undefined;
      if (old) {
        // (no counter is read or changed: a duplicate acks even past a lowered limit)
        if (toHex(old.cji_sha) === toHex(cjiSha)) return { ack: true };
        console.error(`gradebook: a second, different CJI for cid ${cji.cid}; the first is kept`);
        return invalid("duplicate_mismatch");
      }
      const lim = this.limits(s);
      const m = this.exec(
        "SELECT (SELECT count(*) FROM collections WHERE member = ?1) AS n FROM members WHERE member = ?1",
        cji.member,
      ).toArray()[0] as { n: number } | undefined;
      const failedResource = cji.seal.outcome === "failed_resource";
      const add = CHARGE.collection + (failedResource ? CHARGE.rebuild : 0) + (m ? 0 : CHARGE.member);
      if (!m && s.members_count + 1 > lim["grading.members_per_placement"]) return { full: { limit: "members" } };
      if ((m?.n ?? 0) + 1 > lim["grading.collections_per_member"]) return { full: { limit: "collections_per_member" } };
      if (s.charged_bytes + add > lim["grading.gradebook_bytes"]) return { full: { limit: "gradebook_bytes" } };
      const now = Date.now();
      const verified = cji.seal.outcome === "verified";
      this.exec(
        `INSERT INTO collections (cid, member, n, creason, drev, xrev, d, at_seq, chain, frozen_head, late, outcome,
           reason, value_sha256, census_sha256, outputs_digest, aid, assignment_rev, bundle_sha, cji_sha,
           course_epoch, recv_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cji.cid, cji.member, cji.n, COLLECTION_REASONS.indexOf(cji.reason), cji.rev.drev, cji.rev.xrev, cji.d,
        cji.seal.at_seq, fromHex(cji.seal.chain), cji.seal.frozen_head, cji.seal.late ? 1 : 0,
        OUTCOMES.indexOf(cji.seal.outcome), verified ? null : FAILURE_REASONS.indexOf(cji.seal.reason!),
        verified ? fromHex(cji.value!.sha256) : null, verified ? fromHex(cji.census!.sha256) : null,
        verified ? fromHex(cji.outputs_digest!) : null, cji.binding.aid, cji.binding.assignment_rev,
        fromHex(cji.binding.bundle_sha), cjiSha, env.course_epoch, now,
      );
      if (!m) {
        // (settings is replaced only by a purge; a handle made with an older secret is never stored)
        if (toHex(this.secret()) !== toHex(secret)) return { retry: { after_ms: RETRY_AFTER_MS } };
        this.exec("INSERT INTO members (member, handle) VALUES (?, ?)", cji.member, handle);
      }
      if (failedResource)
        this.exec("INSERT INTO rebuilds (cid, state, course_epoch, at_ms) VALUES (?, ?, ?, ?)", cji.cid, REBUILD.open, env.course_epoch, now);
      this.exec(
        "UPDATE state SET members_count = members_count + ?, charged_bytes = charged_bytes + ? WHERE k = 0",
        m ? 0 : 1,
        add,
      );
      return { ack: true };
    });
  }

  // collection_rebuilt (§4.1, A2 §4): merged monotonically, open → built → conflict.
  collectionRebuilt(envelope: unknown, raw: unknown): Answer {
    let env: { course_epoch: number };
    let msg: Rebuilt;
    try {
      env = validateEnvelope(envelope);
      msg = validateRebuilt(raw);
    } catch (e) {
      if (e instanceof WireError) return invalid(e.code);
      throw e;
    }
    const first: Triple = msg.state === "built" ? msg.built : msg.first;
    const same = (v: ArrayBuffer | null, c: ArrayBuffer | null, o: ArrayBuffer | null, t: Triple) =>
      toHex(v) === t.value_sha256 && toHex(c) === t.census_sha256 && toHex(o) === t.outputs_digest;
    return this.ctx.storage.transactionSync((): Answer => {
      const s = this.state();
      if (env.course_epoch < s.epoch_floor) return { purged: true };
      const r = this.exec("SELECT state, v1, c1, o1 FROM rebuilds WHERE cid = ?", msg.cid).toArray()[0] as
        | { state: number; v1: ArrayBuffer | null; c1: ArrayBuffer | null; o1: ArrayBuffer | null }
        | undefined;
      if (!r) {
        // (never ack a cid it doesn't have: Course resends after collection_sealed, §4.4 trace 6)
        const c = this.exec("SELECT 1 FROM collections WHERE cid = ?", msg.cid).toArray()[0];
        return c ? invalid("not_failed_resource") : { retry: { after_ms: RETRY_AFTER_MS } };
      }
      if (r.state === REBUILD.conflict) return { ack: true }; // (the last state; anything later is a no-op)
      if (r.state === REBUILD.built) {
        if (!same(r.v1, r.c1, r.o1, first)) {
          console.error(`gradebook: rebuild of ${msg.cid}: a first slot that differs from the recorded built`);
          return invalid("conflict_mismatch");
        }
        if (msg.state === "built") return { ack: true };
      }
      const second = msg.state === "conflict" ? msg.second : null;
      this.exec(
        "UPDATE rebuilds SET state = ?, v1 = ?, c1 = ?, o1 = ?, v2 = ?, c2 = ?, o2 = ?, at_ms = ? WHERE cid = ?",
        msg.state === "built" ? REBUILD.built : REBUILD.conflict,
        fromHex(first.value_sha256), fromHex(first.census_sha256), fromHex(first.outputs_digest),
        second ? fromHex(second.value_sha256) : null, second ? fromHex(second.census_sha256) : null,
        second ? fromHex(second.outputs_digest) : null, Date.now(), msg.cid,
      );
      return { ack: true };
    });
  }

  // For LTI amendment 5's blob request (G2 r4 §1.3): Course only, one indexed read.
  collection_member(cid: unknown): { member: string } | { unknown: true } {
    if (typeof cid !== "string" || cid.length === 0 || cid.length > 64) return { unknown: true };
    const r = this.exec("SELECT member FROM collections WHERE cid = ?", cid).toArray()[0] as { member: string } | undefined;
    return r ? { member: r.member } : { unknown: true };
  }

  // ---------------------------------------------------------------------------
  // G2 r4 step 2: manual grading. Course is the only caller (§1.1), forwarding the envelope.

  // The clock of G2's records and of A1.2c's backoff (the test entry sets it).
  protected now(): number {
    return Date.now();
  }

  private g2<T>(envelope: unknown, f: (g: G2, env: GradingEnvelope) => T): T | GradingAnswer {
    let env: GradingEnvelope;
    try {
      env = validateGradingEnvelope(envelope);
    } catch (e) {
      if (e instanceof WireError) return { invalid: { reason: e.message } };
      throw e;
    }
    try {
      // (one transaction: a Refusal thrown inside rolls back everything the operation wrote)
      return this.ctx.storage.transactionSync(() => {
        const s = this.state();
        const g = new G2(this.exec.bind(this), env, this.limits(s), s.limits_version, this.now());
        g.fence(s.epoch_floor);
        g.staffOnly(); // (learners read their released grades through step 6's my_grades, never here)
        return f(g, env);
      });
    } catch (e) {
      if (e instanceof Refusal) return e.answer;
      throw e;
    }
  }

  private parsed<R>(f: () => R): R | GradingAnswer {
    try {
      return f();
    } catch (e) {
      if (e instanceof Refusal) return e.answer;
      throw e;
    }
  }

  rubric(envelope: unknown, question: unknown) {
    const q = this.parsed(() => parseQuestionId(question));
    if (typeof q !== "string") return q;
    return this.g2(envelope, (g) => g.rubric(q));
  }

  rubricWrite(envelope: unknown, req: unknown): GradingAnswer {
    const r = this.parsed(() => parseRubricRequest(req));
    if (!("question" in r)) return r;
    return this.g2(envelope, (g) => g.rubricWrite(r)) as GradingAnswer;
  }

  grade(envelope: unknown, req: unknown): GradingAnswer {
    // (comment_chars is read before the transaction only to size the codec; the write itself
    // re-reads every limit inside it)
    const r = this.parsed(() => parseGradeRequest(req, this.limits(this.state())["grading.comment_chars"]));
    if (!("member" in r)) return r;
    return this.g2(envelope, (g) => g.grade(r)) as GradingAnswer;
  }

  ungrade(envelope: unknown, req: unknown): GradingAnswer {
    const r = this.parsed(() => parseUngradeRequest(req));
    if (!("member" in r)) return r;
    return this.g2(envelope, (g) => g.ungrade(r)) as GradingAnswer;
  }

  gradeRow(envelope: unknown, k: unknown) {
    const r = this.parsed(() => parseUngradeRequest({ ...(k as object), base_rev: 0 }));
    if (!("member" in r)) return r;
    const key: GradeKey = { member: r.member, question: r.question, cid: r.cid };
    return this.g2(envelope, (g) => g.gradeView(key));
  }

  gradesByQuestion(envelope: unknown, question: unknown, after: unknown, limit: unknown) {
    const q = this.parsed(() => parseQuestionId(question));
    if (typeof q !== "string") return q;
    let a: { member: string; cid: string } | null = null;
    if (after !== null && after !== undefined) {
      const k = this.parsed(() => parseUngradeRequest({ ...(after as object), question: q, base_rev: 0 }));
      if (!("member" in k)) return k;
      a = { member: k.member, cid: k.cid };
    }
    const n = Number.isSafeInteger(limit) ? (limit as number) : 1000;
    return this.g2(envelope, (g) => g.gradesByQuestion(q, a, n));
  }

  choice(envelope: unknown, member: unknown) {
    const r = this.parsed(() => parseChoiceRequest({ member, cid: null, base_rev: 0 }));
    if (!("member" in r)) return r;
    return this.g2(envelope, (g) => g.choiceView(r.member));
  }

  choose(envelope: unknown, req: unknown): GradingAnswer {
    const r = this.parsed(() => parseChoiceRequest(req));
    if (!("member" in r)) return r;
    return this.g2(envelope, (g) => g.choose(r)) as GradingAnswer;
  }

  // Addendum A1 r5: Course only, with G1's envelope {course_epoch} and the in-transaction fence.
  private courseOnly(envelope: unknown, f: (g: G2) => GradingAnswer): GradingAnswer {
    let env: { course_epoch: number };
    try {
      env = validateEnvelope(envelope);
    } catch (e) {
      if (e instanceof WireError) return { invalid: { reason: e.message } };
      throw e;
    }
    // (a G2 with Course as its actor; no grading role is involved)
    const genv: GradingEnvelope = { course_epoch: env.course_epoch, actor: "course", role: "instructor", staff: "instructor", session: "0".repeat(32) };
    try {
      return this.ctx.storage.transactionSync(() => {
        const s = this.state();
        const g = new G2(this.exec.bind(this), genv, this.limits(s), s.limits_version, this.now());
        g.fence(s.epoch_floor);
        return f(g);
      });
    } catch (e) {
      if (e instanceof Refusal) return e.answer;
      throw e;
    }
  }

  // A1.2: the questions of a bundle's spec, from Course's trusted bundle read.
  spec_put(envelope: unknown, bundle_sha: unknown, questions: unknown): GradingAnswer {
    const r = this.parsed(() => {
      if (typeof bundle_sha !== "string" || !/^[0-9a-f]{64}$/.test(bundle_sha)) throw new Refusal({ invalid: { reason: "bundle_sha: 64 lowercase hex" } });
      return parseSpecQuestions(questions);
    });
    if (!Array.isArray(r)) return r;
    return this.courseOnly(envelope, (g) => g.specPut(bundle_sha as string, r));
  }

  // A1.2c: the outcome of a failed hydration.
  spec_outcome(envelope: unknown, bundle_sha: unknown, outcome: unknown, reason: unknown): GradingAnswer {
    if (typeof bundle_sha !== "string" || !/^[0-9a-f]{64}$/.test(bundle_sha)) return { invalid: { reason: "bundle_sha: 64 lowercase hex" } };
    if (!SPEC_OUTCOMES.includes(outcome as SpecOutcome)) return { invalid: { reason: `outcome: one of ${SPEC_OUTCOMES.join(", ")}` } };
    if (typeof reason !== "string" || reason.length > 64 || !/^[\x20-\x7e]*$/.test(reason)) return { invalid: { reason: "reason: ≤ 64 ASCII" } };
    if (outcome === "full" && reason !== "grades_bytes" && reason !== "specs_per_placement") return { invalid: { reason: "reason: a full outcome names grades_bytes or specs_per_placement" } };
    return this.courseOnly(envelope, (g) => g.specOutcome(bundle_sha, outcome as SpecOutcome, reason));
  }

  // §3.6: epoch-fenced, paged and resumable.
  teardown(E: number, purge_id: string): TeardownAnswer {
    if (!Number.isSafeInteger(E) || E < 0 || E > 0xffffffff || typeof purge_id !== "string" || purge_id.length === 0 || purge_id.length > 64)
      throw new Error("teardown: bad arguments");
    // One state read per call (1 statement). A first call then writes the cursor and the floor,
    // before any page, as one of its 4 transactions; each page is ≤ 3 statements. So a call
    // makes ≤ 1 + 1 + 3 × 3 = 11 statements (a first call) or ≤ 1 + 4 × 3 = 13 (later ones).
    const s = this.state();
    let txns = 0;
    let cur: Cursor;
    if (s.t_purge_id === purge_id) {
      if (s.t_step === "done") return { done: true };
      cur = { step: s.t_step!, e: s.t_e!, ke: s.t_key_epoch!, kc: s.t_key_cid! };
    } else {
      if (s.t_purge_id !== null && s.t_e !== null && E <= s.t_e) return { stale: true };
      this.ctx.storage.transactionSync(() => {
        this.exec(
          `UPDATE state SET epoch_floor = max(epoch_floor, ?), t_purge_id = ?, t_e = ?, t_step = 'rebuilds',
             t_key_epoch = -1, t_key_cid = '' WHERE k = 0`,
          E, purge_id, E,
        );
      });
      txns++;
      cur = { step: "rebuilds", e: E, ke: -1, kc: "" };
    }
    while (txns < TEARDOWN_TXNS_PER_CALL) {
      const next = { ...cur };
      const done = this.ctx.storage.transactionSync(() => this.page(next));
      cur = next; // (only after the page's transaction committed)
      txns++;
      if (done) return { done: true };
    }
    return { more: true };
  }

  // One page transaction, ≤ 3 statements. Returns true once the teardown is finished.
  private page(cur: Cursor): boolean {
    if (cur.step === "done") return true;
    if (cur.step === "state") {
      // (the counters were maintained exactly, page by page: rows of epochs ≥ E survive a delayed
      // purge after a revive, and stay charged. So the last step only marks the teardown done.)
      this.exec("UPDATE state SET t_step = 'done' WHERE k = 0");
      cur.step = "done";
      return true;
    }
    const table = cur.step === "rebuilds" ? "rebuilds" : "collections";
    // (an index range seek on (course_epoch, cid): rows of newer epochs are never read)
    const gone = this.exec(
      `DELETE FROM ${table} WHERE (course_epoch, cid) IN (
         SELECT course_epoch, cid FROM ${table} WHERE course_epoch < ? AND (course_epoch, cid) > (?, ?)
         ORDER BY course_epoch, cid LIMIT ${TEARDOWN_PAGE_ROWS})
       RETURNING course_epoch, cid${table === "collections" ? ", member" : ""}`,
      cur.e, cur.ke, cur.kc,
    ).toArray() as { course_epoch: number; cid: string; member?: string }[];
    if (gone.length === 0) {
      const next = table === "rebuilds" ? "collections" : "state";
      this.exec("UPDATE state SET t_step = ?, t_key_epoch = -1, t_key_cid = '' WHERE k = 0", next);
      Object.assign(cur, { step: next, ke: -1, kc: "" });
      return false;
    }
    let last = gone[0];
    for (const g of gone) if (g.course_epoch > last.course_epoch || (g.course_epoch === last.course_epoch && g.cid > last.cid)) last = g;
    let freed = gone.length * (table === "rebuilds" ? CHARGE.rebuild : CHARGE.collection);
    let membersGone = 0;
    if (table === "collections") {
      // (the members of this page with no collection left go with it)
      membersGone = this.exec(
        `DELETE FROM members WHERE member IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM collections c WHERE c.member = members.member) RETURNING member`,
        JSON.stringify([...new Set(gone.map((g) => g.member!))]),
      ).toArray().length;
      freed += membersGone * CHARGE.member;
    }
    this.exec(
      `UPDATE state SET charged_bytes = charged_bytes - ?, members_count = members_count - ?,
         t_key_epoch = ?, t_key_cid = ? WHERE k = 0`,
      freed, membersGone, last.course_epoch, last.cid,
    );
    cur.ke = last.course_epoch;
    cur.kc = last.cid;
    return false;
  }
}
