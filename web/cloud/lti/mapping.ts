// The random-handle mapping and erasure (amendment 1 r6 to plan-lti-r5:
// §2.4 issuance and its guards, §4.1 erasure, §4.3 pacing).  These run inside
// the registration's `Reg` object, on its SQLite; Reg is the one issuer of
// every external handle.

import { b64urlDecode, b64urlEncode, hmacHex, LtiError, randomHex, utf8, testGate } from "./util.ts";
import type { D1 } from "./db.ts";

export type HandleKind = "person" | "member" | "course";

export const CAPS = { persons: 200_000, person_courses: 1_000_000, courses: 1_000, open_erasures: 100, receipts: 10_000, lost: 1_201_000, erasures_per_day: 200 };
export const RECEIPT_MS = 30 * 86_400_000;
export const FRESH_MS = 25 * 86_400_000;
export const D1_HWM_MS = 60_000;
export const ITEMS_PER_WAKE = 50;
export const PAGE = 200;
export const MAX_ATTEMPTS = 12;

export interface MappingEnv {
  ENV?: string;
  LTI_DB?: D1;
  LTI_AUDIT?: D1;
  LTI_KEY?: string;
  MAPPING_BACKUP_KEY?: string;
  COCALC_ORIGIN?: string;
  LTI_COURSE?: DurableObjectNamespace<{ eraseMember(memberRef: string, eraseId: string, personRef: string): Promise<{ ok: true } | { ok: false; code: string }> }>;
  /** the environment's outbound ceiling (§15.4); unbound means no cocalc.ai call is made */
  LTI_FLEET?: DurableObjectNamespace<{ reserve(): Promise<boolean> | boolean }>;
}

export type Answer<T> = { ok: true; value: T } | { ok: false; code: string };
const no = <T>(code: string): Answer<T> => ({ ok: false, code });

export const MAPPING_SCHEMA = `
CREATE TABLE IF NOT EXISTS mapping (one INTEGER PRIMARY KEY CHECK (one = 1), epoch_id TEXT NOT NULL, seq INTEGER NOT NULL, witnessed INTEGER NOT NULL, last_d1 INTEGER NOT NULL, hold TEXT);
CREATE TABLE IF NOT EXISTS persons (person_int TEXT PRIMARY KEY, person_ref TEXT NOT NULL UNIQUE, state TEXT NOT NULL, seq INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS person_courses (person_int TEXT NOT NULL, course TEXT NOT NULL, member_ref TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL, PRIMARY KEY (person_int, course));
CREATE TABLE IF NOT EXISTS courses (course TEXT PRIMARY KEY, course_ref TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lost_handles (handle TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS erasures (erase_id TEXT PRIMARY KEY, person_int TEXT NOT NULL, person_ref TEXT, state TEXT NOT NULL, sealed TEXT NOT NULL, nonce TEXT NOT NULL, started INTEGER NOT NULL, issued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, ext_person INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS erasure_items (erase_id TEXT NOT NULL, course TEXT NOT NULL, member_ref TEXT, course_state TEXT NOT NULL, ext_state TEXT NOT NULL, PRIMARY KEY (erase_id, course));
CREATE TABLE IF NOT EXISTS erase_receipts (erase_id TEXT PRIMARY KEY, person_ref TEXT, completed INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS erase_receipts_completed ON erase_receipts (completed);
CREATE TABLE IF NOT EXISTS erase_admits (day INTEGER PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tallies (k TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0));
`;

/** The tables whose caps are checked by a scalar counter kept in the same transaction (LIMIT-STAGEA2-2), never by count(*). */
const TALLIED = ["persons", "person_courses", "courses", "lost_handles", "erasures", "erase_receipts"] as const;
type Tallied = (typeof TALLIED)[number];

const count = (sql: SqlStorage, q: string, ...b: unknown[]) => (sql.exec(q, ...b).one() as { n: number }).n;
const row = <T>(sql: SqlStorage, q: string, ...b: unknown[]): T | undefined => [...sql.exec(q, ...b)][0] as T | undefined;

/** The external handles one launch needs (§2). */
export interface Issued { person_ref: string; person_seq: number; member_ref: string; member_seq: number; course_ref: string; course_seq: number; epoch_id: string }

/**
 * AES-GCM under SHA-256(MAPPING_BACKUP_KEY), with a stored nonce, so a retry
 * seals identically (astra's acceptance item).  The result is a self-contained
 * versioned envelope, `v1.<nonce>.<ciphertext ‖ tag>`, so a journal row
 * decrypts from the backup key alone, after Reg's job state is gone
 * (CORR-LTIMAP-2).  ≤ 200 characters for the journal's payload.
 */
export async function seal(keyText: string, nonceHex: string, plain: string): Promise<string> {
  const raw = await crypto.subtle.digest("SHA-256", utf8(keyText));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = new Uint8Array(nonceHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plain))))}`;
}

/** Open a journal envelope with the backup key alone (the recovery path, and its test). */
export async function unseal(keyText: string, envelope: string): Promise<string | null> {
  const m = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/.exec(envelope);
  if (!m) return null;
  try {
    const raw = await crypto.subtle.digest("SHA-256", utf8(keyText));
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(m[1]) }, key, b64urlDecode(m[2])));
  } catch {
    return null;
  }
}

/** True only in web/cloud/lti/test-entry.ts's Worker: the test seams below are off in every deployed entry. */
const testMode = () => (globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ === true;

/**
 * A response body, decoded, cancelled as soon as it passes `max` bytes, so no
 * more than `max` plus one chunk is ever held (LIMIT-STAGEA2-1).  null if over.
 */
export async function readCapped(r: Response, max: number): Promise<string | null> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) all.set(p, o), (o += p.byteLength);
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

export class Mapping {
  /** (tests) handle values to hand out before random ones, to inject collisions */
  private forced: string[] = [];
  constructor(
    private sql: SqlStorage,
    private env: MappingEnv,
    private rid: () => string,
    private arm: (at: number) => Promise<void>,
    /** cocalc.ai calls' admission (amendment 1 r6 §4.3: the entitlement envelope), or null when refused; release after */
    private reserveOut: () => Promise<{ release(): void } | null> = async () => null,
  ) {
    sql.exec(MAPPING_SCHEMA);
    // (a store made before the counters: one recount, once)
    for (const t of TALLIED) if (![...sql.exec("SELECT 1 FROM tallies WHERE k = ?", t)].length) sql.exec(`INSERT INTO tallies (k, n) SELECT ?, count(*) FROM ${t}`, t);
  }

  private n(t: Tallied): number {
    return (this.sql.exec("SELECT n FROM tallies WHERE k = ?", t).one() as { n: number }).n;
  }
  private tally(t: Tallied, d: number): void {
    if (d) this.sql.exec("UPDATE tallies SET n = n + ? WHERE k = ?", d, t);
  }

  private newHandle(): string {
    if (testMode() && this.forced.length) return this.forced.shift()!;
    return randomHex(16);
  }

  /** (tests only) force the next handle values; seed admissions or receipts; no effect outside the test entry */
  testSeam(op: { force?: string[]; admits?: number; receipts?: { n: number; age_ms: number }; tallies?: Record<string, number> }): boolean {
    if (!testMode()) return false;
    for (const [k, n] of Object.entries(op.tallies ?? {})) this.sql.exec("UPDATE tallies SET n = ? WHERE k = ?", n, k);
    if (op.force) this.forced.push(...op.force);
    if (op.admits !== undefined) this.sql.exec("INSERT INTO erase_admits (day, n) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET n = excluded.n", Math.floor(Date.now() / 86_400_000), op.admits);
    if (op.receipts) {
      this.sql.exec("DELETE FROM erase_receipts WHERE erase_id LIKE 'seed-%'");
      for (let i = 0; i < op.receipts.n; i++) this.sql.exec("INSERT INTO erase_receipts (erase_id, person_ref, completed) VALUES (?, NULL, ?)", `seed-${i}`, Date.now() - op.receipts.age_ms);
      this.sql.exec("UPDATE tallies SET n = (SELECT count(*) FROM erase_receipts) WHERE k = 'erase_receipts'");
    }
    return true;
  }

  private mapping() {
    return row<{ epoch_id: string; seq: number; witnessed: number; last_d1: number; hold: string | null }>(this.sql, "SELECT * FROM mapping WHERE one = 1");
  }

  private nextSeq(): number {
    this.sql.exec("UPDATE mapping SET seq = seq + 1 WHERE one = 1");
    return this.mapping()!.seq;
  }

  private setHold(reason: string): void {
    this.sql.exec("UPDATE mapping SET hold = ? WHERE one = 1", reason);
  }

  private async witness(): Promise<{ epoch: string | null; seq: number; hold: number } | null> {
    return this.env.LTI_DB!.prepare("SELECT mapping_epoch AS epoch, mapping_seq AS seq, mapping_hold AS hold FROM registrations WHERE rid = ?").bind(this.rid()).first();
  }

  /** The §2.4 guards, against D1's witness.  Synchronous after the await, so nothing interleaves. */
  private guard(w: { epoch: string | null; seq: number; hold: number }): string | null {
    const m = this.mapping();
    if (w.hold) return "hold";
    if (!m && w.epoch !== null) {
      // (an empty store while D1 has an epoch: lost, never a new registration)
      this.sql.exec("INSERT INTO mapping (one, epoch_id, seq, witnessed, last_d1, hold) VALUES (1, ?, ?, 1, 0, 'lost')", w.epoch, w.seq);
      return "hold";
    }
    if (m && w.epoch !== null && m.epoch_id !== w.epoch) return this.setHold("epoch"), "hold";
    if (m && m.seq < w.seq) return this.setHold("rollback"), "hold";
    if (m?.hold) return "hold";
    return null;
  }

  /** Get-or-create every handle for a launch: person, course, member, in one guarded pass (§2.4). */
  async issue(personInt: string, course: string): Promise<Answer<Issued>> {
    for (let pass = 0; pass < 3; pass++) {
      const w = await this.witness();
      if (!w) return no("registration");
      const g = this.guard(w);
      if (g) return no(g);
      // existing handles go out even while an identity hold blocks new ones
      const p = row<{ person_ref: string; seq: number; state: string }>(this.sql, "SELECT person_ref, seq, state FROM persons WHERE person_int = ?", personInt);
      if (p && p.state !== "live") return no("removed");
      const c = row<{ course_ref: string; seq: number }>(this.sql, "SELECT course_ref, seq FROM courses WHERE course = ?", course);
      const pc = row<{ member_ref: string; seq: number }>(this.sql, "SELECT member_ref, seq FROM person_courses WHERE person_int = ? AND course = ?", personInt, course);
      const m0 = this.mapping();
      if (p && c && pc && m0) return { ok: true, value: { person_ref: p.person_ref, person_seq: p.seq, member_ref: pc.member_ref, member_seq: pc.seq, course_ref: c.course_ref, course_seq: c.seq, epoch_id: m0.epoch_id } };
      if (row(this.sql, "SELECT 1 AS x FROM lost_handles WHERE state = 'unresolved' LIMIT 1")) return no("identity_hold");
      if ((!p && this.n("persons") >= CAPS.persons) || (!c && this.n("courses") >= CAPS.courses) || (!pc && this.n("person_courses") >= CAPS.person_courses)) return no("registration_full");
      // the first epoch is witnessed in D1 before any handle escapes (§2.4 guard 1)
      if (!m0) this.sql.exec("INSERT INTO mapping (one, epoch_id, seq, witnessed, last_d1, hold) VALUES (1, ?, 0, 0, 0, NULL)", randomHex(16));
      const m = this.mapping()!;
      if (!m.witnessed) {
        const r = await this.env.LTI_DB!.prepare("UPDATE registrations SET mapping_epoch = ?, mapping_seq = max(mapping_seq, ?) WHERE rid = ? AND (mapping_epoch IS NULL OR mapping_epoch = ?) RETURNING mapping_epoch").bind(m.epoch_id, m.seq, this.rid(), m.epoch_id).all();
        if (r.results.length !== 1) {
          this.setHold("epoch");
          return no("hold");
        }
        this.sql.exec("UPDATE mapping SET witnessed = 1, last_d1 = ? WHERE one = 1", Date.now());
        continue; // (re-check every guard after that await)
      }
      // synchronous from here: get-or-create with uniqueness and collision retry
      // every new value is chosen first (unique across all kinds, the lost ones, and each other), then all are
      // inserted, so a collision that exhausts its retries leaves nothing half-issued
      const taken = new Set<string>();
      const fresh = (): string => {
        for (let i = 0; i < 3; i++) {
          const h = this.newHandle();
          if (!taken.has(h) && !row(this.sql, "SELECT 1 AS x FROM persons WHERE person_ref = ?", h) && !row(this.sql, "SELECT 1 AS x FROM person_courses WHERE member_ref = ?", h) && !row(this.sql, "SELECT 1 AS x FROM courses WHERE course_ref = ?", h) && !row(this.sql, "SELECT 1 AS x FROM lost_handles WHERE handle = ?", h)) {
            taken.add(h);
            return h;
          }
        }
        throw new LtiError(503, "collision");
      };
      const hp = p ? null : fresh(), hc = c ? null : fresh(), hm = pc ? null : fresh();
      let pr = p, cr = c, mr = pc;
      if (hp) {
        const seq = this.nextSeq();
        this.sql.exec("INSERT INTO persons (person_int, person_ref, state, seq, created) VALUES (?, ?, 'live', ?, ?)", personInt, hp, seq, Date.now());
        this.tally("persons", 1);
        pr = { person_ref: hp, seq, state: "live" };
      }
      if (hc) {
        const seq = this.nextSeq();
        this.sql.exec("INSERT INTO courses (course, course_ref, seq) VALUES (?, ?, ?)", course, hc, seq);
        this.tally("courses", 1);
        cr = { course_ref: hc, seq };
      }
      if (hm) {
        const seq = this.nextSeq();
        this.sql.exec("INSERT INTO person_courses (person_int, course, member_ref, seq) VALUES (?, ?, ?, ?)", personInt, course, hm, seq);
        this.tally("person_courses", 1);
        mr = { member_ref: hm, seq };
      }
      const now = Date.now();
      const mm = this.mapping()!;
      if (now - mm.last_d1 > D1_HWM_MS) {
        this.sql.exec("UPDATE mapping SET last_d1 = ? WHERE one = 1", now);
        await this.env.LTI_DB!.prepare("UPDATE registrations SET mapping_seq = max(mapping_seq, ?) WHERE rid = ? AND mapping_epoch = ?").bind(mm.seq, this.rid(), mm.epoch_id).run();
      }
      return { ok: true, value: { person_ref: pr.person_ref, person_seq: pr.seq, member_ref: mr.member_ref, member_seq: mr.seq, course_ref: cr.course_ref, course_seq: cr.seq, epoch_id: mm.epoch_id } };
    }
    return no("hold");
  }

  /** Write D1's high-water mark now (phase changes, §2.4). */
  private async hwm(): Promise<void> {
    const m = this.mapping();
    if (!m) return;
    this.sql.exec("UPDATE mapping SET last_d1 = ? WHERE one = 1", Date.now());
    await this.env.LTI_DB!.prepare("UPDATE registrations SET mapping_seq = max(mapping_seq, ?) WHERE rid = ? AND mapping_epoch = ?").bind(m.seq, this.rid(), m.epoch_id).run();
  }

  // ---- recovery (§2.4)

  /** cocalc.ai's reported (seq, handle, kind) list: a handle missing here becomes a lost handle, and the registration holds. */
  reconcile(handles: { seq: number; handle: string; kind: HandleKind }[]): Answer<{ lost: number; conflicts: number }> {
    let lost = 0, conflicts = 0;
    const tableOf = (k: HandleKind) => (k === "person" ? ["persons", "person_ref"] : k === "member" ? ["person_courses", "member_ref"] : ["courses", "course_ref"]);
    // the cap is checked once for the whole page, by the counter, before anything is written (LIMIT-STAGEA2-2)
    const fresh = new Set(handles.filter((h) => !row(this.sql, `SELECT 1 AS x FROM ${tableOf(h.kind)[0]} WHERE ${tableOf(h.kind)[1]} = ?`, h.handle) && !row(this.sql, "SELECT 1 AS x FROM lost_handles WHERE handle = ?", h.handle)).map((h) => h.handle));
    if (this.n("lost_handles") + fresh.size > CAPS.lost) return no("lost_full");
    for (const h of handles) {
      const t = h.kind === "person" ? ["persons", "person_ref"] : h.kind === "member" ? ["person_courses", "member_ref"] : ["courses", "course_ref"];
      const local = row<{ seq: number }>(this.sql, `SELECT seq FROM ${t[0]} WHERE ${t[1]} = ?`, h.handle);
      if (local) {
        if (local.seq !== h.seq) conflicts++;
        continue;
      }
      if (!row(this.sql, "SELECT 1 AS x FROM lost_handles WHERE handle = ?", h.handle)) {
        this.sql.exec("INSERT INTO lost_handles (handle, seq, kind, state) VALUES (?, ?, ?, 'unresolved')", h.handle, h.seq, h.kind);
        this.tally("lost_handles", 1);
        lost++;
      }
    }
    if (lost || conflicts) {
      if (!this.mapping()) this.sql.exec("INSERT INTO mapping (one, epoch_id, seq, witnessed, last_d1, hold) VALUES (1, ?, 0, 1, 0, 'lost')", randomHex(16));
      this.setHold(conflicts ? "conflict" : "lost");
    }
    // (the next seq goes above every reported one)
    const top = Math.max(0, ...handles.map((h) => h.seq));
    this.sql.exec("UPDATE mapping SET seq = max(seq, ?) WHERE one = 1", top);
    return { ok: true, value: { lost, conflicts } };
  }

  /** An operator's decision for one lost handle: its seq, handle AND kind must match (astra's acceptance item). */
  resolveLost(d: { seq: number; handle: string; kind: HandleKind; decision: "bind" | "retire"; person_int?: string; course?: string }): Answer<null> {
    const l = row<{ seq: number; kind: string; state: string }>(this.sql, "SELECT seq, kind, state FROM lost_handles WHERE handle = ?", d.handle);
    if (!l || l.state !== "unresolved") return no("not_lost");
    if (l.seq !== d.seq || l.kind !== d.kind) return no("mismatch");
    if (d.decision === "retire") {
      this.sql.exec("UPDATE lost_handles SET state = 'retired' WHERE handle = ?", d.handle);
      return { ok: true, value: null };
    }
    if (d.kind === "person") {
      if (!d.person_int) return no("params");
      const p = row<{ person_ref: string }>(this.sql, "SELECT person_ref FROM persons WHERE person_int = ?", d.person_int);
      if (p) return no(p.person_ref === d.handle ? "already" : "subject_has_handle");
      if (this.n("persons") >= CAPS.persons) return no("registration_full");
      this.sql.exec("INSERT INTO persons (person_int, person_ref, state, seq, created) VALUES (?, ?, 'live', ?, ?)", d.person_int, d.handle, d.seq, Date.now());
      this.tally("persons", 1);
    } else if (d.kind === "member") {
      if (!d.person_int || !d.course) return no("params");
      if (!row(this.sql, "SELECT 1 AS x FROM persons WHERE person_int = ?", d.person_int)) return no("person_first");
      if (row(this.sql, "SELECT 1 AS x FROM person_courses WHERE person_int = ? AND course = ?", d.person_int, d.course)) return no("subject_has_handle");
      if (this.n("person_courses") >= CAPS.person_courses) return no("registration_full");
      this.sql.exec("INSERT INTO person_courses (person_int, course, member_ref, seq) VALUES (?, ?, ?, ?)", d.person_int, d.course, d.handle, d.seq);
      this.tally("person_courses", 1);
    } else {
      if (!d.course) return no("params");
      if (row(this.sql, "SELECT 1 AS x FROM courses WHERE course = ?", d.course)) return no("subject_has_handle");
      if (this.n("courses") >= CAPS.courses) return no("registration_full");
      this.sql.exec("INSERT INTO courses (course, course_ref, seq) VALUES (?, ?, ?)", d.course, d.handle, d.seq);
      this.tally("courses", 1);
    }
    this.sql.exec("UPDATE lost_handles SET state = 'bound' WHERE handle = ?", d.handle);
    return { ok: true, value: null };
  }

  /** mapping-release: only at or above D1's mark and every reported seq, and with no unresolved lost handle. */
  async release(epochId: string, reportedSeq: number): Promise<Answer<{ seq: number }>> {
    const w = await this.witness();
    if (!w) return no("registration");
    const m = this.mapping();
    if (!m || m.epoch_id !== epochId) return no("epoch");
    if (row(this.sql, "SELECT 1 AS x FROM lost_handles WHERE state = 'unresolved' LIMIT 1")) return no("lost_unresolved");
    const floor = Math.max(w.seq, reportedSeq);
    if (m.seq < floor) this.sql.exec("UPDATE mapping SET seq = ? WHERE one = 1", floor);
    const seq = this.nextSeq();
    this.sql.exec("UPDATE mapping SET hold = NULL WHERE one = 1");
    await this.env.LTI_DB!.prepare("UPDATE registrations SET mapping_hold = 0, mapping_epoch = ?, mapping_seq = ? WHERE rid = ?").bind(m.epoch_id, seq, this.rid()).run();
    this.sql.exec("UPDATE mapping SET last_d1 = ? WHERE one = 1", Date.now());
    return { ok: true, value: { seq } };
  }

  /** The restore procedure's first step: D1's hold, then the local one. */
  async hold(): Promise<void> {
    await this.env.LTI_DB!.prepare("UPDATE registrations SET mapping_hold = 1 WHERE rid = ?").bind(this.rid()).run();
    if (this.mapping()) this.setHold("restore");
  }

  // ---- erasure (§4.1)

  /** the open-job cap, and the receipt cap with every open job holding the one receipt it will write (LIMIT-STAGEA2-2) */
  private full(): boolean {
    const open = this.n("erasures");
    return open >= CAPS.open_erasures || this.n("erase_receipts") + open >= CAPS.receipts;
  }

  async startErase(e: { erase_id: string; person_int: string; issued_at: number }): Promise<Answer<{ state: string; person_ref: string | null }>> {
    const now = Date.now();
    if (!(e.issued_at <= now + 300_000) || now - e.issued_at > FRESH_MS) return no("stale");
    const rcpt = row<{ person_ref: string | null }>(this.sql, "SELECT person_ref FROM erase_receipts WHERE erase_id = ?", e.erase_id);
    if (rcpt) return { ok: true, value: { state: "completed", person_ref: rcpt.person_ref } };
    const open = row<{ state: string; person_ref: string | null }>(this.sql, "SELECT state, person_ref FROM erasures WHERE erase_id = ?", e.erase_id);
    if (open) return { ok: true, value: { state: open.state, person_ref: open.person_ref } };
    // compaction first, then the caps, then the day's admission
    this.tally("erase_receipts", -[...this.sql.exec("DELETE FROM erase_receipts WHERE erase_id IN (SELECT erase_id FROM erase_receipts WHERE completed < ? LIMIT 100) RETURNING 1", now - RECEIPT_MS)].length);
    if (this.full()) return no("erasure_capacity");
    const day = Math.floor(now / 86_400_000);
    const used = row<{ n: number }>(this.sql, "SELECT n FROM erase_admits WHERE day = ?", day)?.n ?? 0;
    if (used >= CAPS.erasures_per_day) return no("erasure_capacity");
    if (!this.env.MAPPING_BACKUP_KEY) return no("not_configured");
    const p = row<{ person_ref: string; state: string }>(this.sql, "SELECT person_ref, state FROM persons WHERE person_int = ?", e.person_int);
    if (p && p.state !== "live") return no("in_progress");
    // the sealed journal payload and its nonce are fixed now, so every retry writes the identical row
    const nonce = randomHex(12);
    const sealed = await seal(this.env.MAPPING_BACKUP_KEY, nonce, JSON.stringify({ person_int: e.person_int, person_ref: p?.person_ref ?? null }));
    // (re-check after the await: nothing may have started this person meanwhile)
    if (row(this.sql, "SELECT 1 AS x FROM erasures WHERE erase_id = ?", e.erase_id) || row(this.sql, "SELECT 1 AS x FROM erase_receipts WHERE erase_id = ?", e.erase_id)) return this.startErase(e);
    const p2 = row<{ person_ref: string; state: string }>(this.sql, "SELECT person_ref, state FROM persons WHERE person_int = ?", e.person_int);
    if ((p2?.person_ref ?? null) !== (p?.person_ref ?? null) || (p2 && p2.state !== "live")) return no("in_progress");
    // every capacity again, synchronously, immediately before the row and counter writes (CORR-LTIMAP-6): calls
    // that were all admitted before their awaits are admitted here one at a time, so they can't overshoot
    const used2 = row<{ n: number }>(this.sql, "SELECT n FROM erase_admits WHERE day = ?", day)?.n ?? 0;
    if (this.full() || used2 >= CAPS.erasures_per_day) return no("erasure_capacity");
    // the fence and the manifest, in one transaction: every member_ref is persisted before anything is deleted
    this.sql.exec("INSERT INTO erase_admits (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1", day);
    if (p) this.sql.exec("UPDATE persons SET state = 'erasing' WHERE person_int = ?", e.person_int);
    this.sql.exec("INSERT INTO erasures (erase_id, person_int, person_ref, state, sealed, nonce, started, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", e.erase_id, e.person_int, p?.person_ref ?? null, p ? "courses" : "journal_pending", sealed, nonce, now, e.issued_at);
    this.tally("erasures", 1);
    this.sql.exec("INSERT INTO erasure_items (erase_id, course, member_ref, course_state, ext_state) SELECT ?, course, member_ref, 'pending', 'pending' FROM person_courses WHERE person_int = ?", e.erase_id, e.person_int);
    if (this.mapping()) this.nextSeq();
    await this.arm(now);
    return { ok: true, value: { state: p ? "courses" : "journal_pending", person_ref: p?.person_ref ?? null } };
  }

  /** One alarm wake of erasure work: ≤ 50 items in total, round-robin across jobs (§4.3).  Answers the next wake time, or null. */
  async step(fetcher: (req: Request) => Promise<Response> = (r) => fetch(r)): Promise<number | null> {
    let budget = ITEMS_PER_WAKE;
    const now = Date.now();
    let progressed = true;
    while (budget > 0 && progressed) {
      progressed = false;
      const jobs = [...this.sql.exec("SELECT * FROM erasures WHERE next_at <= ? ORDER BY started", now)] as Record<string, unknown>[];
      for (const j of jobs) {
        if (budget <= 0) break;
        const used = await this.stepJob(j, fetcher);
        if (used > 0) progressed = true;
        budget -= used;
      }
    }
    const next = row<{ t: number | null }>(this.sql, "SELECT min(next_at) AS t FROM erasures")?.t ?? null;
    if (next === null) return null;
    return Math.max(next, now + (budget <= 0 ? 0 : 1));
  }

  private fail(eraseId: string): void {
    const j = row<{ attempts: number }>(this.sql, "SELECT attempts FROM erasures WHERE erase_id = ?", eraseId)!;
    const a = j.attempts + 1;
    // (full jitter, 1 s to 1 h; after 12 attempts the episode ends and the job waits an hour before the next)
    const base = Math.min(3600_000, 1000 * 2 ** Math.min(a, 12));
    const wait = a >= MAX_ATTEMPTS ? 3600_000 : Math.floor(Math.random() * base) + 1000;
    this.sql.exec("UPDATE erasures SET attempts = ?, next_at = ? WHERE erase_id = ?", a >= MAX_ATTEMPTS ? 0 : a, Date.now() + wait, eraseId);
  }

  /** Advance one job by at most one item; answers the items used (0 if nothing was due).  State changes cost no item. */
  private async stepJob(j: Record<string, unknown>, fetcher: (req: Request) => Promise<Response>): Promise<number> {
    const id = j.erase_id as string;
    const personRef = j.person_ref as string | null;
    for (;;) {
      const state = row<{ state: string; ext_person: number }>(this.sql, "SELECT state, ext_person FROM erasures WHERE erase_id = ?", id);
      if (!state) return 0;
      if (state.state === "courses") {
        const it = row<{ course: string; member_ref: string | null }>(this.sql, "SELECT course, member_ref FROM erasure_items WHERE erase_id = ? AND course_state = 'pending' LIMIT 1", id);
        if (!it) {
          this.sql.exec("UPDATE erasures SET state = 'external' WHERE erase_id = ?", id);
          continue;
        }
        if (it.member_ref !== null) {
          try {
            // keyed by the manifest's OLD random member_ref (r5): a P2 relaunch is never touched
            const r = await this.env.LTI_COURSE!.get(this.env.LTI_COURSE!.idFromName(it.course)).eraseMember(it.member_ref, id, personRef ?? "");
            if (!r.ok) throw new Error(r.code);
          } catch {
            this.fail(id);
            return 1;
          }
        }
        this.sql.exec("UPDATE erasure_items SET course_state = 'done' WHERE erase_id = ? AND course = ?", id, it.course);
        return 1;
      }
      if (state.state === "external") {
        const page = [...this.sql.exec("SELECT course, member_ref FROM erasure_items WHERE erase_id = ? AND ext_state = 'pending' ORDER BY course LIMIT ?", id, PAGE)] as { course: string; member_ref: string | null }[];
        if (!page.length && (state.ext_person || personRef === null)) {
          this.sql.exec("UPDATE erasures SET state = 'journal_pending' WHERE erase_id = ?", id);
          continue;
        }
        const ok = await this.purgePage(id, personRef, page.map((p) => p.member_ref).filter((m): m is string => m !== null), fetcher);
        if (!ok) {
          this.fail(id);
          return 1;
        }
        for (const p of page) this.sql.exec("UPDATE erasure_items SET ext_state = 'acked' WHERE erase_id = ? AND course = ?", id, p.course);
        this.sql.exec("UPDATE erasures SET ext_person = 1, attempts = 0 WHERE erase_id = ?", id);
        return 1;
      }
      if (state.state === "journal_pending") {
        // step 5.2: the idempotent journal write, then read back as its acknowledgement
        await testGate("erase_journal");
        try {
          await this.env.LTI_AUDIT!.prepare("INSERT INTO erase_journal (erase_id, rid, sealed, completed) VALUES (?, ?, ?, ?) ON CONFLICT (erase_id) DO NOTHING").bind(id, this.rid(), j.sealed, Date.now()).run();
          const back = await this.env.LTI_AUDIT!.prepare("SELECT sealed FROM erase_journal WHERE erase_id = ?").bind(id).first<{ sealed: string }>();
          if (!back || back.sealed !== j.sealed) throw new Error("journal mismatch");
        } catch {
          this.fail(id);
          return 1;
        }
        // step 5.3: only after the acknowledgement, the receipt and the deletions, in one transaction
        // the deletions are bound to this erasure's captured incarnation (CORR-LTIMAP-3): only the memberships its
        // manifest named, and only the person row holding its person_ref, so a later incarnation, issued while an
        // absent-person erasure ran, keeps every row
        this.sql.exec("INSERT INTO erase_receipts (erase_id, person_ref, completed) VALUES (?, ?, ?)", id, personRef, Date.now());
        this.tally("erase_receipts", 1);
        this.tally("person_courses", -[...this.sql.exec("DELETE FROM person_courses WHERE person_int = ? AND member_ref IN (SELECT member_ref FROM erasure_items WHERE erase_id = ? AND member_ref IS NOT NULL) RETURNING 1", j.person_int, id)].length);
        this.tally("persons", -[...this.sql.exec("DELETE FROM persons WHERE person_int = ? AND state = 'erasing' AND person_ref IS ? RETURNING 1", j.person_int, personRef)].length);
        this.sql.exec("DELETE FROM erasure_items WHERE erase_id = ?", id);
        this.sql.exec("DELETE FROM erasures WHERE erase_id = ?", id);
        this.tally("erasures", -1);
        if (this.mapping()) this.nextSeq();
        await this.hwm();
        return 1;
      }
      return 0;
    }
  }

  /** cocalc.ai's purge-person, one page, signed; acknowledged only by a 200 with {ok: true} (§4.1 step 4, §4.3's envelope). */
  private async purgePage(eraseId: string, personRef: string | null, memberRefs: string[], fetcher: (req: Request) => Promise<Response>): Promise<boolean> {
    if (!this.env.COCALC_ORIGIN || !this.env.LTI_KEY) return false;
    const path = "/api/v2/sagebrush/lti/purge-person";
    const body = JSON.stringify({ rid: this.rid(), erase_id: eraseId, person_ref: personRef, member_refs: memberRefs });
    const t = String(Date.now());
    const sig = await hmacHex(this.env.LTI_KEY, `POST\n${path}\n${t}\n${body}`);
    // the entitlement envelope (LIMIT-STAGEA2-1): Reg's shared bucket, the daily outbound budget and Fleet, all
    // reserved before the fetch; a refusal makes no fetch
    const lease = await this.reserveOut();
    if (!lease) return false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetcher(new Request(this.env.COCALC_ORIGIN + path, { method: "POST", headers: { "content-type": "application/json", "x-lti-time": t, "x-lti-signature": sig }, body, redirect: "manual", signal: ctl.signal }));
      const text = await readCapped(r, 16 * 1024);
      return r.status === 200 && text !== null && JSON.parse(text)?.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      lease.release();
    }
  }

  /** (tests) the state a test inspects */
  inspect(): Record<string, unknown> {
    return {
      mapping: this.mapping() ?? null,
      persons: count(this.sql, "SELECT count(*) AS n FROM persons"),
      tallies: Object.fromEntries([...this.sql.exec("SELECT k, n FROM tallies")].map((r) => [(r as { k: string }).k, (r as { n: number }).n])),
      person_refs: [...this.sql.exec("SELECT person_ref FROM persons ORDER BY created LIMIT 5")].map((r) => (r as { person_ref: string }).person_ref),
      person_courses: count(this.sql, "SELECT count(*) AS n FROM person_courses"),
      erasures: [...this.sql.exec("SELECT erase_id, state, attempts, sealed, nonce FROM erasures")],
      receipts: count(this.sql, "SELECT count(*) AS n FROM erase_receipts"),
      lost: [...this.sql.exec("SELECT handle, seq, kind, state FROM lost_handles")],
    };
  }
}

