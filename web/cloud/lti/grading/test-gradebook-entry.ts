// The Worker that test-gradebook.mjs runs in Miniflare: only the Gradebook, with test hooks
// (statement counts, database size, crash injection, bulk max-width fill). No deployed entry
// exports this subclass.

import { Gradebook as Base } from "./gradebook.ts";
import { G2_CHARGE, recountG2 } from "./grades.ts";
import { commentCharge } from "./marks.ts";

export class Gradebook extends Base {
  private failAt = 0; // throw on the Nth statement from now (0: never)
  private clock: number | null = null; // (a fixed clock for A1.2c's backoff; null: the real one)

  protected now(): number {
    return this.clock ?? Date.now();
  }

  __clock(ms: number | null): void {
    this.clock = ms;
  }

  __g2(): Record<string, number> {
    const n = (t: string) => (this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM ${t}`).one() as { n: number }).n;
    const s = this.ctx.storage.sql.exec("SELECT rev_seq, grades_charged, comment_charged FROM settings").one() as Record<string, number>;
    const t = ["rubric_items", "rubric_questions", "grades", "comments", "member_choice", "release", "settings", "specs", "spec_outcomes"];
    return { ...Object.fromEntries(t.map((x) => [x, n(x)])), ...s };
  }

  __recountG2(): { grades_charged: number; comment_charged: number } {
    return recountG2((q, ...a) => this.ctx.storage.sql.exec(q, ...a));
  }

  // Every member's handle, as stored (hex), for the anonymity amendment's checks.
  __handles(): Record<string, string | null> {
    const rows = this.ctx.storage.sql.exec("SELECT member, hex(handle) AS h FROM members").toArray() as { member: string; h: string | null }[];
    return Object.fromEntries(rows.map((r) => [r.member, r.h === null || r.h === "" ? null : r.h.toLowerCase()]));
  }

  protected exec(query: string, ...args: unknown[]) {
    if (this.failAt > 0 && --this.failAt === 0) throw new Error("injected crash");
    return super.exec(query, ...args);
  }

  __stats(): { statements: number; size: number } {
    return { statements: this.statements, size: this.ctx.storage.sql.databaseSize };
  }

  __resetStats(): void {
    this.statements = 0;
  }

  __failAt(n: number): void {
    this.failAt = n;
  }

  __rows(): Record<string, number> {
    const n = (t: string) => (this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM ${t}`).one() as { n: number }).n;
    const s = this.ctx.storage.sql.exec("SELECT members_count, charged_bytes, epoch_floor FROM state").one() as Record<string, number>;
    return { collections: n("collections"), rebuilds: n("rebuilds"), members: n("members"), ...s };
  }

  // The counters as the stored rows imply them (§3.1's charges), to check the maintained ones.
  __recount(): { members_count: number; charged_bytes: number } {
    const n = (t: string) => (this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM ${t}`).one() as { n: number }).n;
    const members = n("members");
    return { members_count: members, charged_bytes: n("collections") * 1024 + n("rebuilds") * 1024 + members * 256 };
  }

  __plan(sql: string): string[] {
    return this.ctx.storage.sql.exec(`EXPLAIN QUERY PLAN ${sql}`).toArray().map((r) => String((r as { detail: string }).detail));
  }

  // Maximum-width rows straight into the tables, for the gradebook-size fixture (G1 r5 §3.1):
  // `members` members × `per` collections, each failed_resource with its rebuild row.
  __fill(members: number, per: number, epoch: number, start = 0): void {
    const key = (p: string, i: number) => (p + i.toString(36)).padEnd(64, "~");
    const blob = (i: number) => {
      const b = new Uint8Array(32);
      new DataView(b.buffer).setUint32(0, i);
      b.fill(0xff, 4);
      return b;
    };
    const sql = this.ctx.storage.sql;
    let k = start * per;
    for (let m = start; m < start + members; m++) {
      this.ctx.storage.transactionSync(() => {
        const member = key("m", m);
        sql.exec("INSERT INTO members (member, handle) VALUES (?, ?)", member, blob(0x40000000 + m).slice(0, 16));
        for (let c = 0; c < per; c++, k++) {
          const cid = key("c", k);
          sql.exec(
            `INSERT INTO collections (cid, member, n, creason, drev, xrev, d, at_seq, chain, frozen_head, late, outcome,
               reason, value_sha256, census_sha256, outputs_digest, aid, assignment_rev, bundle_sha, cji_sha,
               course_epoch, recv_ms)
             VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            cid, member, 0x7fffffff - c, 0x7fffffff, 0x7fffffff, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1,
            blob(k), Number.MAX_SAFE_INTEGER, blob(k + 1), blob(k + 2), blob(k + 3), key("a", m), 0x7fffffff, blob(k + 4),
            blob(k + 5), epoch, Number.MAX_SAFE_INTEGER,
          );
          sql.exec(
            "INSERT INTO rebuilds (cid, state, v1, c1, o1, v2, c2, o2, course_epoch, at_ms) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?)",
            cid, blob(k), blob(k + 1), blob(k + 2), blob(k + 3), blob(k + 4), blob(k + 5), epoch, Number.MAX_SAFE_INTEGER,
          );
        }
      });
    }
    sql.exec(
      "UPDATE state SET members_count = members_count + ?, charged_bytes = charged_bytes + ? WHERE k = 0",
      members,
      members * 256 + members * per * 2048,
    );
  }

  // Maximum-width rows of every G2 table, for the grades-size fixture (G2 r4 §8): `members`
  // members × `per` grade rows (a `withComment` share carrying a maximum-length comment, the
  // rest tombstones), `items` rubric items and `questions` question rows, one member_choice per
  // member, 101 release rows. Counters are set from the rows' exact charges.
  __fillG2(o: { members: number; per: number; start: number; commentChars: number; withComment: number; items: number; questions: number; epoch: number; fixed: boolean }): void {
    const sql = this.ctx.storage.sql;
    const key = (p: string, i: number) => (p + i.toString(36)).padEnd(64, "~");
    const qid = (i: number) => ("q" + i.toString(36)).padEnd(32, "_");
    const b32 = (i: number) => {
      const b = new Uint8Array(32);
      new DataView(b.buffer).setUint32(0, i);
      b.fill(0xff, 4);
      return b;
    };
    // (the widest stored text: 3-byte UTF-8 characters)
    const wide = (n: number) => "\u20ac".repeat(n);
    const text = wide(o.commentChars);
    const reason = wide(200);
    const anchors = JSON.stringify(Array.from({ length: 8 }, (_, i) => ("\u20ac" + i).padEnd(128, "\u20ac")));
    let grades = 0, comments = 0;
    for (let m = o.start; m < o.start + o.members; m++) {
      this.ctx.storage.transactionSync(() => {
        const member = key("m", m);
        for (let g = 0; g < o.per; g++) {
          const cid = key("c", m * o.per + g);
          const question = qid(g);
          const commented = g < o.withComment;
          sql.exec(
            `INSERT INTO grades (member, question, cid, state, items, adjust_c, basis_value, basis_census, slot, has_comment, grader, at_ms, rev, course_epoch)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            member, question, cid, commented ? 0 : 1, new Uint8Array(8).fill(0xff), -1_000_000, b32(m), b32(g), 2, commented ? 1 : 0,
            key("g", m), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - g, o.epoch,
          );
          grades++;
          if (commented) {
            sql.exec("INSERT INTO comments (member, question, cid, text, reason, anchors, course_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)", member, question, cid, text, reason, anchors, o.epoch);
            comments += commentCharge({ text, reason, anchors: JSON.parse(anchors) }, { member, question, cid });
          }
        }
        sql.exec("INSERT OR IGNORE INTO member_choice (member, cid, by, at_ms, rev, course_epoch) VALUES (?, ?, ?, ?, ?, ?)", member, key("c", m * o.per), key("b", m), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, o.epoch);
      });
    }
    let fixed = 0;
    if (o.fixed) {
      this.ctx.storage.transactionSync(() => {
        for (let i = 0; i < o.questions; i++)
          sql.exec("INSERT INTO rubric_questions (question, start, rev, course_epoch) VALUES (?, 1, ?, ?)", qid(i), Number.MAX_SAFE_INTEGER, o.epoch);
        for (let i = 0; i < o.items; i++)
          sql.exec(
            `INSERT INTO rubric_items (question, slot, label, description, points_c, state, pos, by, at_ms, rev, course_epoch)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
            qid(Math.floor(i / 64)), i % 64, wide(200), wide(1000), -1_000_000, 0x7fffffff, key("b", i), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, o.epoch,
          );
        for (let i = 0; i < 101; i++)
          sql.exec("INSERT INTO release (scope, state, by, at_ms, rev, course_epoch) VALUES (?, 1, ?, ?, ?, ?)", i === 0 ? "assignment" : qid(i), key("b", i), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, o.epoch);
        // (addendum A1: 64 maximal specs rows, 100 pairs of 32-character ids and 7-digit points, and 64 outcome rows)
      for (let i = 0; i < 64; i++) {
        const q = JSON.stringify(Array.from({ length: 100 }, (_, j) => [("s" + i.toString(36) + "_" + j.toString(36)).padEnd(32, "x"), 1_000_000]));
        sql.exec("INSERT INTO specs (bundle_sha, questions, state, course_epoch) VALUES (?, ?, 1, ?)", b32(0x50000000 + i), q, o.epoch);
        sql.exec(
          "INSERT INTO spec_outcomes (bundle_sha, outcome, reason, limits_version, attempts, next_try, at_ms, course_epoch) VALUES (?, 3, ?, ?, ?, ?, ?, ?)",
          b32(0x60000000 + i), "r".repeat(64), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, o.epoch,
        );
      }
      // (a full toggle ledger: 16 entries of 24 B)
        sql.exec("UPDATE settings SET toggle_ledger = ?, toggle_hw = ?, category = 1, release_mode = 1, anon_state = 2, anon_rev = ? WHERE k = 0", new Uint8Array(16 * 24).fill(0xff), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      });
      fixed = o.questions * G2_CHARGE.rubric_question + o.items * G2_CHARGE.rubric_item + 101 * G2_CHARGE.release + 64 * (G2_CHARGE.spec + G2_CHARGE.spec_outcome);
    }
    sql.exec(
      "UPDATE settings SET grades_charged = grades_charged + ?, comment_charged = comment_charged + ? WHERE k = 0",
      grades * G2_CHARGE.grade + o.members * G2_CHARGE.member_choice + comments + fixed,
      comments,
    );
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
