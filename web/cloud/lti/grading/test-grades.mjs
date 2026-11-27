// ci: none (test-gradebook.mjs runs it, on its Miniflare)
// Grading G2 r4 (b51b4a30) step 2: the Gradebook's manual-grading tables (§2.0–2.6, §6, §8) in
// Miniflare, with real Durable Object SQLite. Run by test-gradebook.mjs on its Miniflare
// instance (so CI's line is unchanged). Synthetic data only.
//
// GRADES_CEILING=1 also runs the grades-size fixture at the ceiling scale (separately from G1's
// GRADEBOOK_CEILING=1); G2_SIZE=0 skips the default-scale one, G2_FUZZ_OPS sets the random run's length.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

export async function run({ fresh, ok, js, cji, hx, env: g1env }) {
  // ---------------------------------------------------------------------------
  // §6's cross-field rules (checked at the admin write of the limits record)
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const out = join(mkdtempSync(join(tmpdir(), "grades-")), "grades.mjs");
    writeFileSync(out, execFileSync("bun", ["build", join(here, "grades.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
    const { gradingLimitErrors, G2_LIMITS } = await import(out);
    const defaults = Object.fromEntries(Object.entries(G2_LIMITS).map(([k, s]) => [k, s.default]));
    ok(gradingLimitErrors(defaults).length === 0, "limits: the defaults satisfy every cross-field rule");
    const ceilings = Object.fromEntries(Object.entries(G2_LIMITS).map(([k, s]) => [k, s.max]));
    ok(gradingLimitErrors(ceilings).length === 0, "limits: the ceilings satisfy every cross-field rule", js(gradingLimitErrors(ceilings)));
    ok(gradingLimitErrors({ ...defaults, "grading.comment_bytes": 2 ** 30, "grading.grades_bytes": 2 ** 29 }).some((e) => e.startsWith("comment_bytes")), "limits: comment_bytes > grades_bytes refused");
    // (within the ranges this rule always holds: the largest comment charge, at comment_chars'
    // ceiling, is ~110 KB, under comment_bytes' 1 MiB floor. A below-floor value exercises it.)
    ok(gradingLimitErrors({ ...defaults, "grading.comment_bytes": G2_LIMITS["grading.comment_bytes"].min, "grading.comment_chars": G2_LIMITS["grading.comment_chars"].max }).length === 0, "limits: a maximal comment at the ceiling fits comment_bytes' floor");
    ok(gradingLimitErrors({ ...defaults, "grading.comment_bytes": 100_000, "grading.comment_chars": 16000 }).some((e) => e.startsWith("one maximal comment")), "limits: a maximal comment that doesn't fit refused");
    ok(gradingLimitErrors({ ...defaults, "grading.writes_per_minute_session": 600, "grading.writes_per_minute_placement": 60 }).some((e) => e.startsWith("writes_per_minute")), "limits: session rate over placement rate refused");
    for (const [k, s] of Object.entries(G2_LIMITS)) ok(s.min <= s.default && s.default <= s.max, `limits: ${k} default within [floor, ceiling]`);
  }

  const SESSION = "0".repeat(32);
  const E = (o = {}) => ({ course_epoch: 1, actor: "actor-1", role: "instructor", staff: "instructor", session: SESSION, ...o });
  const TA = E({ actor: "ta-1", staff: "ta", session: "1".repeat(32) });
  const BASIS = { value_sha256: hx("1"), census_sha256: hx("2") };
  const okRev = (a) => (a && a.ok ? a.ok.rev : null);
  const SPEC = 8192; // a specs row's charge (addendum A1 r5)

  // A Gradebook with members m1, m2 (verified collections c1, c2), m1's older c1b, a
  // failed_resource collection fr (m1), a failed_integrity fi (m2), and the spec of bundle b.
  async function setup() {
    const g = fresh();
    await g.collectionSealed(g1env(), cji({ cid: "c1", member: "m1", n: 2 }));
    await g.collectionSealed(g1env(), cji({ cid: "c1b", member: "m1", n: 1 }));
    await g.collectionSealed(g1env(), cji({ cid: "c2", member: "m2" }));
    await g.collectionSealed(g1env(), cji({ cid: "fr", member: "m1", n: 3, outcome: "failed_resource" }));
    await g.collectionSealed(g1env(), cji({ cid: "fi", member: "m2", n: 2, outcome: "failed_integrity" }));
    const put = await g.spec_put(g1env(), hx("b"), [["q1", 400], ["q2", 600], ["q3", 1000]]);
    if (js(put) !== js({ ok: { rev: 0 } })) throw new Error("setup: spec_put " + js(put));
    return g;
  }
  const grade = (o = {}) => ({ member: "m1", question: "q1", cid: "c1", base_rev: 0, items: [], adjust_c: 0, basis: BASIS, ...o });
  const invariant = async (g, what) => {
    const s = await g.__g2();
    const r = await g.__recountG2();
    ok(s.grades_charged === r.grades_charged && s.comment_charged === r.comment_charged, `invariant: ${what}`, js({ s, r }));
  };

  // ---------------------------------------------------------------------------
  // settings and members.handle (§0.1, §3.1)
  {
    const g = await setup();
    const s = await g.__g2();
    ok(s.settings === 1 && s.rev_seq === 0 && s.grades_charged === 1024 + SPEC && s.comment_charged === 0 && s.specs === 1, "settings: created with its own 1,024 B reserved (plus the setup's spec row)", js(s));
    const h = await g.__handles();
    ok(/^[0-9a-f]{32}$/.test(h.m1) && /^[0-9a-f]{32}$/.test(h.m2) && h.m1 !== h.m2, "members.handle: written with every member row", js(h));
    const g2 = await setup();
    const h2 = await g2.__handles();
    ok(h2.m1 !== h.m1, "members.handle: unlinkable across placements (each has its own secret)");
    const r = await g.__rows();
    ok(r.charged_bytes === 5 * 1024 + 1024 + 2 * 256, "members.handle: G1's charges unchanged", js(r));
  }

  // ---------------------------------------------------------------------------
  // the envelope and roles (§1.1, §1.2)
  {
    const g = await setup();
    ok(js(await g.grade({ course_epoch: 1 }, grade())).includes("invalid"), "envelope: G1's bare envelope is invalid for G2");
    ok(js(await g.grade(E({ session: "s" }), grade())).includes("invalid"), "envelope: a session that isn't a 128-bit handle");
    ok(js(await g.grade(E({ staff: null }), grade())).includes("invalid"), "envelope: instructor without staff");
    ok(js(await g.grade(E({ role: "learner", staff: null }), grade())) === js({ forbidden: true }), "roles: a learner can't grade");
    ok(js(await g.rubric(E({ role: "learner", staff: null }), "q1")) === js({ forbidden: true }), "roles: a learner can't read the rubric");
    ok(okRev(await g.grade(TA, grade())) > 0, "roles: a TA grades");
    ok(okRev(await g.rubricWrite(TA, { question: "q1", base_rev: 0, op: { add: { label: "units", points_c: -100 } } })) > 0, "roles: a TA edits the rubric");
    ok(okRev(await g.choose(TA, { member: "m1", cid: "c1b", base_rev: 0 })) > 0, "roles: a TA chooses the counted collection");
    const row = await g.gradeRow(E(), { member: "m1", question: "q1", cid: "c1" });
    ok(row.grader === "ta-1", "the grader is the envelope's actor, never the body's", js(row));
  }

  // ---------------------------------------------------------------------------
  // the rubric (§2.2)
  {
    const g = await setup();
    let r = await g.rubricWrite(E(), { question: "q1", base_rev: 0, op: { add: { label: "correct", points_c: 400 } } });
    const r1 = okRev(r);
    ok(r1 > 0, "rubric: the first write creates the question row");
    ok(js(await g.rubricWrite(E(), { question: "q1", base_rev: 0, op: { add: { label: "x", points_c: 1 } } })).includes("conflict"), "rubric: a stale base_rev is a conflict");
    r = await g.rubricWrite(E(), { question: "q1", base_rev: r1, op: { add: { label: "missing units", points_c: -200, description: "−2" } } });
    const r2 = okRev(r);
    let v = await g.rubric(E(), "q1");
    ok(v.rev === r2 && v.items.length === 2 && v.items[0].slot === 0 && v.items[1].slot === 1 && v.start === "zero", "rubric: slots 0, 1; start zero", js(v));
    const r3 = okRev(await g.rubricWrite(E(), { question: "q1", base_rev: r2, op: { retire: { slot: 0 } } }));
    const r4 = okRev(await g.rubricWrite(E(), { question: "q1", base_rev: r3, op: { add: { label: "third", points_c: 5 } } }));
    v = await g.rubric(E(), "q1");
    ok(v.items.find((i) => i.slot === 0).state === "retired" && v.items.some((i) => i.slot === 2), "rubric: retiring keeps the slot; the next item takes slot 2 (never reused)", js(v));
    const r5 = okRev(await g.rubricWrite(E(), { question: "q1", base_rev: r4, op: { restore: { slot: 0 } } }));
    const r6 = okRev(await g.rubricWrite(E(), { question: "q1", base_rev: r5, op: { reorder: { slots: [2, 1, 0] } } }));
    v = await g.rubric(E(), "q1");
    ok(v.items.map((i) => i.slot).join() === "2,1,0" && v.items.every((i) => i.state === "active"), "rubric: restore and reorder", js(v));
    ok(js(await g.rubricWrite(E(), { question: "q1", base_rev: r6, op: { reorder: { slots: [2, 1] } } })).includes("invalid"), "rubric: reorder must name every slot");
    ok(js(await g.rubricWrite(E(), { question: "q1", base_rev: r6, op: { edit: { slot: 9, label: "x" } } })).includes("invalid"), "rubric: no such slot");
    ok(js(await g.rubricWrite(E(), { question: "q1", base_rev: r6, op: { add: { label: "", points_c: 1 } } })).includes("invalid"), "rubric: an empty label");
    ok(js(await g.rubricWrite(E(), { question: "q1", base_rev: r6, op: { add: { label: "x", points_c: 1_000_001 } } })).includes("invalid"), "rubric: points over the bound");
    ok(js(await g.rubricWrite(E(), { question: "Q1", base_rev: 0, op: { start: "full" } })).includes("invalid"), "rubric: a bad question id");
    const r7 = okRev(await g.rubricWrite(E(), { question: "q1", base_rev: r6, op: { start: "full" } }));
    ok((await g.rubric(E(), "q1")).start === "full", "rubric: start full");
    // a re-weight changes no grade row (rows read before and after are identical)
    ok(okRev(await g.grade(E(), grade({ items: [1, 2] }))) > 0, "grade: with items");
    const before = js(await g.gradeRow(E(), { member: "m1", question: "q1", cid: "c1" }));
    const s0 = await g.__g2();
    ok(okRev(await g.rubricWrite(E(), { question: "q1", base_rev: r7, op: { edit: { slot: 1, points_c: -100 } } })) > 0, "rubric: re-weight");
    ok(js(await g.gradeRow(E(), { member: "m1", question: "q1", cid: "c1" })) === before, "rubric: a re-weight rewrites no grade row");
    const s1 = await g.__g2();
    ok(s1.grades === s0.grades && s1.grades_charged === s0.grades_charged, "rubric: a re-weight charges nothing", js({ s0, s1 }));
    ok(js(await g.grade(E(), grade({ member: "m2", cid: "c2", items: [7] }))) === js({ stale_rubric: true }), "grade: an unknown slot is stale_rubric");
    await invariant(g, "the rubric");
  }

  // ---------------------------------------------------------------------------
  // grade rows (§2.3): validation, CAS, retries, ungrade
  {
    const g = await setup();
    const k = { member: "m1", question: "q1", cid: "c1" };
    ok(js(await g.grade(E(), grade({ question: "q9" }))).includes("not a question of this collection's spec"), "grade: a question outside the spec");
    ok(js(await g.grade(E(), grade({ cid: "c2" }))).includes("not a collection of this member"), "grade: another member's collection");
    ok(js(await g.grade(E(), grade({ cid: "nope" }))).includes("not a collection"), "grade: an unknown cid");
    ok(js(await g.grade(E(), grade({ basis: { ...BASIS, census_sha256: hx("9") } }))).includes("basis"), "basis: a verified mismatch");
    ok(js(await g.grade(E(), grade({ member: "m2", cid: "fi" }))).includes("basis"), "basis: failed_integrity is never gradable");
    ok(js(await g.grade(E(), grade({ cid: "fr" }))).includes("basis"), "basis: an open rebuild is not gradable");
    ok(js(await g.grade(E(), grade({ adjust_c: 1_000_001 }))).includes("invalid"), "grade: |adjust_c| over the bound");
    ok(js(await g.grade(E(), grade({ items: [1, 1] }))).includes("invalid"), "grade: a slot twice");
    ok(js(await g.grade(E(), grade({ extra: 1 }))).includes("invalid"), "grade: an unknown field");
    let s = await g.__g2();
    ok(s.grades === 0 && s.rev_seq === 0 && s.grades_charged === 1024 + SPEC, "grade: refusals write nothing", js(s));
    // CAS from two sessions: one wins, one conflicts
    const a = await g.grade(E(), grade({ adjust_c: 100 }));
    const b = await g.grade(TA, grade({ adjust_c: 200 }));
    ok(okRev(a) > 0 && js(b).includes("conflict") && b.conflict.current.adjust_c === 100, "grade: two creates, one wins", js({ a, b }));
    // the lost-answer retry: the same base_rev again is a conflict whose current is identical
    const ra = okRev(a);
    const e1 = await g.grade(E(), grade({ base_rev: ra, adjust_c: 150, comment: { text: "good", reason: "half", anchors: ["cell-1"] } }));
    const retry = await g.grade(E(), grade({ base_rev: ra, adjust_c: 150, comment: { text: "good", reason: "half", anchors: ["cell-1"] } }));
    ok(okRev(e1) > ra && js(retry).includes("conflict") && retry.conflict.current.adjust_c === 150 && retry.conflict.current.comment.text === "good", "grade: a retried write sees its own result as current", js(retry));
    s = await g.__g2();
    const cc = s.comment_charged;
    ok(cc > 1024 && s.grades === 1 && s.comments === 1 && s.grades_charged === 1024 + SPEC + 1024 + cc, "grade: the row and its comment charged exactly", js(s));
    // omitting comment keeps it; null removes it
    const e2 = okRev(await g.grade(E(), grade({ base_rev: okRev(e1), adjust_c: 160 })));
    ok((await g.gradeRow(E(), k)).comment.text === "good", "grade: an absent comment is kept");
    const e3 = okRev(await g.grade(E(), grade({ base_rev: e2, comment: null })));
    s = await g.__g2();
    ok(s.comments === 0 && s.comment_charged === 0 && s.grades_charged === 2048 + SPEC, "grade: comment null removes it and its charge", js(s));
    // ungrade: tombstone keeps 1,024 B and the count; the comment's charge is freed
    const e4 = okRev(await g.grade(E(), grade({ base_rev: e3, comment: { text: "again", reason: "", anchors: [] } })));
    const u = okRev(await g.ungrade(E(), { ...k, base_rev: e4 }));
    const row = await g.gradeRow(E(), k);
    s = await g.__g2();
    ok(u > e4 && row.state === "ungraded" && row.items.length === 0 && row.basis === null && row.comment === null, "ungrade: a tombstone", js(row));
    ok(s.grades === 1 && s.comments === 0 && s.comment_charged === 0 && s.grades_charged === 2048 + SPEC, "ungrade: frees the comment, keeps the tombstone's charge", js(s));
    const re = okRev(await g.grade(E(), grade({ base_rev: u, adjust_c: 5 })));
    s = await g.__g2();
    ok(re > u && s.grades === 1 && s.grades_charged === 2048 + SPEC, "regrade: an edit of the tombstone, no new row or charge", js(s));
    ok(js(await g.ungrade(E(), { ...k, base_rev: 0 })).includes("conflict"), "ungrade: base_rev 0 is a conflict");
    // a built rebuild, then a conflict: built and alternate slots
    await g.collectionRebuilt(g1env(), { cid: "fr", state: "built", built: { value_sha256: hx("5"), census_sha256: hx("6"), outputs_digest: hx("7"), by: "a", at: 1 } });
    const okb = await g.grade(E(), grade({ cid: "fr", basis: { value_sha256: hx("5"), census_sha256: hx("6") } }));
    ok(okRev(okb) > 0 && (await g.gradeRow(E(), { member: "m1", question: "q1", cid: "fr" })).slot === "built", "basis: a built rebuild");
    await g.collectionRebuilt(g1env(), {
      cid: "fr",
      state: "conflict",
      first: { value_sha256: hx("5"), census_sha256: hx("6"), outputs_digest: hx("7"), by: "a", at: 1 },
      second: { value_sha256: hx("8"), census_sha256: hx("9"), outputs_digest: hx("a"), by: "b", at: 2 },
    });
    const alt = await g.grade(E(), grade({ question: "q2", cid: "fr", basis: { value_sha256: hx("8"), census_sha256: hx("9") } }));
    ok(okRev(alt) > 0 && (await g.gradeRow(E(), { member: "m1", question: "q2", cid: "fr" })).slot === "alternate", "basis: the alternate slot of a conflict");
    const col = await g.gradesByQuestion(E(), "q1", null, 1);
    const col2 = await g.gradesByQuestion(E(), "q1", { member: col[0].member, cid: col[0].cid }, 10);
    ok(col.length === 1 && col2.length === 1 && col[0].cid !== col2[0].cid && !("comment" in col[0]), "gradesByQuestion: paged by (member, cid), no comment text", js({ col, col2 }));
    await invariant(g, "grades");
  }

  // ---------------------------------------------------------------------------
  // revisions (CORR-G2-1): every stale request is a conflict
  {
    const g = await setup();
    const k = { member: "m1", question: "q1", cid: "c1" };
    // a create held, then graded by someone else, ungraded and re-graded, then delivered
    const x = okRev(await g.grade(TA, grade()));
    const y = okRev(await g.ungrade(TA, { ...k, base_rev: x }));
    const z = okRev(await g.grade(TA, grade({ base_rev: y })));
    ok(js(await g.grade(E(), grade())).includes("conflict"), "revisions: a held create after grade, ungrade, regrade");
    // an edit of rev x held, then ungrade and re-grade, then delivered
    ok(js(await g.grade(E(), grade({ base_rev: x }))).includes("conflict"), "revisions: a held edit of an older rev");
    // a create held across an ungrade, with no re-grade
    const k2 = { member: "m1", question: "q2", cid: "c1" };
    const p = okRev(await g.grade(TA, grade({ question: "q2" })));
    okRev(await g.ungrade(TA, { ...k2, base_rev: p }));
    ok(js(await g.grade(E(), grade({ question: "q2" }))).includes("conflict"), "revisions: a held create across an ungrade (the tombstone)");
    // member_choice: set, clear, set, and the three traces
    const c1 = okRev(await g.choose(TA, { member: "m1", cid: "c1b", base_rev: 0 }));
    const c2 = okRev(await g.choose(TA, { member: "m1", cid: null, base_rev: c1 }));
    const c3 = okRev(await g.choose(TA, { member: "m1", cid: "c1b", base_rev: c2 }));
    ok(c1 > 0 && c2 > c1 && c3 > c2, "member_choice: set, clear, set");
    ok(js(await g.choose(E(), { member: "m1", cid: "c1", base_rev: 0 })).includes("conflict"), "member_choice: a held create");
    ok(js(await g.choose(E(), { member: "m1", cid: "c1", base_rev: c1 })).includes("conflict"), "member_choice: a held edit of an older rev");
    const cv = await g.choice(E(), "m1");
    ok(cv.cid === "c1b" && cv.rev === c3, "member_choice: the current row", js(cv));
    ok(js(await g.choose(E(), { member: "m2", cid: "c1", base_rev: 0 })).includes("not a collection of this member"), "member_choice: another member's cid");
    ok(js(await g.choose(E(), { member: "nobody", cid: null, base_rev: 0 })).includes("not a member"), "member_choice: not a member of the placement");
    // rev values strictly increasing across every table
    const revs = [x, y, z, p, c1, c2, c3];
    ok(revs.every((r, i) => i === 0 || r > revs[i - 1]), "revisions: rev strictly increasing across tables", js(revs));
    // a pre-purge request after a revive is purged, never compared by rev
    await g.teardown(5, "purge-rev");
    let t;
    do t = await g.teardown(5, "purge-rev");
    while (t.more);
    ok(js(await g.grade(E(), grade({ base_rev: z }))) === js({ purged: true }), "fence: a pre-purge write after a revive is purged");
    ok(js(await g.rubric(E(), "q1")) === js({ purged: true }), "fence: a pre-purge read is purged");
    ok(js(await g.collection_member("c1")) === js({ unknown: true }), "collection_member: deleted by the teardown");
  }

  // ---------------------------------------------------------------------------
  // charges and limits (CORR-G2-3, LIMIT-G2-1, §6)
  {
    // comment_bytes at the limit and one past; grown across the boundary; lowered limits
    const g = fresh();
    await g.configure(1, { "grading.comment_bytes": 2 ** 20, "grading.comment_chars": 16000 });
    const members = 6, questions = 10;
    const spec = Object.fromEntries(Array.from({ length: questions }, (_, i) => [`q${i}`, 100]));
    for (let m = 0; m < members; m++) await g.collectionSealed(g1env(), cji({ cid: `c${m}`, member: `m${m}` }));
    await g.spec_put(g1env(), hx("b"), Object.entries(spec));
    const keyOf = (i) => ({ member: `m${Math.floor(i / questions)}`, question: `q${i % questions}`, cid: `c${Math.floor(i / questions)}` });
    const charge = (k, len) => 1024 + 2 * (len + 0 + 2 + k.member.length + k.question.length + k.cid.length);
    let i = 0;
    const limit = 2 ** 20;
    let used = 0;
    const revs = new Map();
    // (every key has the same length, so C0 = charge(k, 0) and Cmax = charge(k, 16,000) are
    // constants: write maximal comments while one more still leaves C0, then one exact one)
    const C0 = charge(keyOf(0), 0), Cmax = charge(keyOf(0), 16000);
    while (limit - used - Cmax >= C0) {
      const a = await g.grade(E(), grade({ ...keyOf(i), comment: { text: "x".repeat(16000), reason: "", anchors: [] } }));
      revs.set(i, okRev(a));
      used += Cmax;
      i++;
    }
    // the last comment fills comment_bytes exactly
    const k = keyOf(i);
    const len = (limit - used - charge(k, 0)) / 2;
    const exactA = await g.grade(E(), grade({ ...k, comment: { text: "x".repeat(len), reason: "", anchors: [] } }));
    let s = await g.__g2();
    ok(okRev(exactA) > 0 && s.comment_charged === limit, "charges: a comment that reaches comment_bytes exactly", js({ s, len }));
    const k1 = keyOf(i + 1);
    const over = await g.grade(E(), grade({ ...k1, comment: { text: "", reason: "", anchors: [] } }));
    const s1 = await g.__g2();
    ok(js(over) === js({ full: { limit: "comment_bytes" } }) && s1.grades === s.grades && s1.rev_seq === s.rev_seq, "charges: comment_bytes + 1 is full, nothing written", js(over));
    const grow = await g.grade(E(), grade({ ...k, base_rev: okRev(exactA), comment: { text: "x".repeat(len + 1), reason: "", anchors: [] } }));
    ok(js(grow) === js({ full: { limit: "comment_bytes" } }), "charges: a comment grown across the boundary is full");
    const shrink = await g.grade(E(), grade({ ...k, base_rev: okRev(exactA), comment: { text: "x", reason: "", anchors: [] } }));
    ok(okRev(shrink) > 0, "charges: shrinking is admitted at the limit");
    // a lowered limit: delta ≤ 0 admitted, delta > 0 full
    await g.configure(2, { "grading.comment_bytes": 2 ** 20, "grading.comment_chars": 16000, "grading.grades_bytes": 4 * 2 ** 20 });
    s = await g.__g2();
    ok(s.grades_charged > 0, "charges: the state before a lowered grades_bytes", js(s));
    await g.configure(3, { "grading.comment_bytes": 2 ** 20, "grading.comment_chars": 200 });
    const e0 = await g.grade(E(), grade({ ...keyOf(0), base_rev: revs.get(0), adjust_c: 7 }));
    ok(okRev(e0) > 0, "charges: an edit with delta 0 is admitted under a lowered comment_chars (the kept comment is not re-checked)");
    await invariant(g, "comment boundaries");
  }
  {
    // grades_bytes at its floor: grade rows at cap and cap + 1
    const g = await setup();
    const LIMIT = 4 * 2 ** 20;
    await g.configure(1, { "grading.grades_bytes": LIMIT, "grading.comment_bytes": 2 ** 20, "grading.comment_chars": 16000 });
    // fill with rubric items (8,192 B each) until 8–16 KiB are left
    let q = 0, slot = 0, rev = 0;
    for (;;) {
      const s = await g.__g2();
      if (s.grades_charged + 8192 + 256 > LIMIT - 8192) break;
      const a = await g.rubricWrite(E(), { question: `r${q}`, base_rev: rev, op: { add: { label: "x", points_c: 1 } } });
      if (!a.ok) {
        ok(false, "charges: filling with rubric items", js(a));
        break;
      }
      rev = a.ok.rev;
      if (++slot === 32) [q, slot, rev] = [q + 1, 0, 0];
    }
    // then one graded row with a comment sized so that exactly 2.5 grade rows' room is left
    let s = await g.__g2();
    const room = LIMIT - s.grades_charged;
    const k0 = { member: "m2", question: "q1", cid: "c2" };
    const C0 = 1024 + 2 * (2 + k0.member.length + k0.question.length + k0.cid.length);
    const len = (room - 1024 - 2560 - C0) / 2;
    ok(Number.isInteger(len) && len >= 0 && len <= 16000, "charges: the sizing comment", js({ room, len }));
    ok(okRev(await g.grade(E(), grade({ ...k0, comment: { text: "x".repeat(len), reason: "", anchors: [] } }))) > 0, "charges: the sizing grade");
    s = await g.__g2();
    ok(LIMIT - s.grades_charged === 2560, "charges: 2,560 B left", js(s));
    ok(okRev(await g.grade(E(), grade())) > 0 && okRev(await g.grade(E(), grade({ question: "q2" }))) > 0, "charges: two grade rows at the cap");
    const before = await g.__g2();
    const over = await g.grade(E(), grade({ question: "q3" }));
    const after = await g.__g2();
    ok(js(over) === js({ full: { limit: "grades_bytes" } }) && js(after) === js(before), "charges: the third is full, nothing written", js(over));
    ok(okRev(await g.rubricWrite(E(), { question: "r0", base_rev: (await g.rubric(E(), "r0")).rev, op: { retire: { slot: 0 } } })) > 0, "charges: a delta-0 write is admitted at the cap");
    await invariant(g, "grades_bytes");
  }
  {
    // count limits: grades_per_member (tombstones count), rubric_items_per_question, _per_placement
    const g = await setup();
    await g.configure(1, { "grading.grades_per_member": 2 });
    const a = okRev(await g.grade(E(), grade()));
    okRev(await g.grade(E(), grade({ question: "q2" })));
    ok(js(await g.grade(E(), grade({ question: "q3" }))) === js({ full: { limit: "grades_per_member" } }), "limits: grades_per_member at cap + 1");
    okRev(await g.ungrade(E(), { member: "m1", question: "q1", cid: "c1", base_rev: a }));
    ok(js(await g.grade(E(), grade({ question: "q3" }))) === js({ full: { limit: "grades_per_member" } }), "limits: a tombstone keeps its place in grades_per_member");
    ok(okRev(await g.grade(E(), grade({ member: "m2", cid: "c2" }))) > 0, "limits: grades_per_member is per member");
    await g.configure(2, { "grading.grades_per_member": 2, "grading.rubric_items_per_question": 1, "grading.rubric_items_per_placement": 2 });
    const r1 = okRev(await g.rubricWrite(E(), { question: "q1", base_rev: 0, op: { add: { label: "a", points_c: 1 } } }));
    ok(js(await g.rubricWrite(E(), { question: "q1", base_rev: r1, op: { add: { label: "b", points_c: 1 } } })) === js({ full: { limit: "rubric_items_per_question" } }), "limits: rubric_items_per_question");
    const r2 = okRev(await g.rubricWrite(E(), { question: "q2", base_rev: 0, op: { add: { label: "a", points_c: 1 } } }));
    ok(r2 > 0, "limits: a second question's item");
    ok(js(await g.rubricWrite(E(), { question: "q3", base_rev: 0, op: { add: { label: "a", points_c: 1 } } })) === js({ full: { limit: "rubric_items_per_placement" } }), "limits: rubric_items_per_placement (question rows, then items)");
    ok(okRev(await g.rubricWrite(E(), { question: "q1", base_rev: r1, op: { retire: { slot: 0 } } })) > 0, "limits: retiring is admitted at the cap");
    await invariant(g, "count limits");
  }

  // ---------------------------------------------------------------------------
  // a crash mid-mutation leaves rows and counters unchanged (the instrumented exec)
  {
    const g = await setup();
    okRev(await g.rubricWrite(E(), { question: "q1", base_rev: 0, op: { add: { label: "a", points_c: 1 } } }));
    let crashed = 0;
    for (let n = 1; n <= 16; n++) {
      const before = js(await g.__g2());
      await g.__failAt(n);
      let threw = false;
      let a;
      try {
        a = await g.grade(E(), grade({ question: "q2", cid: "c1b", base_rev: 0, items: [], comment: { text: "t".repeat(n), reason: "", anchors: [] } }));
      } catch {
        threw = true;
      }
      await g.__failAt(0);
      if (threw) {
        crashed++;
        ok(js(await g.__g2()) === before, `crash at statement ${n}: rows and counters unchanged`);
      } else {
        ok(okRev(a) > 0, `no crash at statement ${n}: the write committed`, js(a));
        break;
      }
    }
    ok(crashed >= 4, "crash: injected at every statement of a grade write", String(crashed));
    await invariant(g, "after crashes");
  }

  // ---------------------------------------------------------------------------
  // the invariant: after 10,000 random operations, with crashes and lowered limits, both counters
  // equal the sum of the stored rows' charges
  {
    const g = await setup();
    let seed = 12345;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const cids = [["m1", "c1"], ["m1", "c1b"], ["m2", "c2"]];
    const qs = ["q1", "q2", "q3"];
    const revOf = async (k) => (await g.gradeRow(E(), k))?.rev ?? 0;
    const N = Number(process.env.G2_FUZZ_OPS ?? 10000);
    let crashes = 0;
    for (let i = 0; i < N; i++) {
      const [member, cid] = cids[rnd(3)];
      const k = { member, question: qs[rnd(3)], cid };
      if (rnd(50) === 0) await g.configure(i + 10, { "grading.comment_bytes": 2 ** 20 * (1 + rnd(2)), "grading.grades_per_member": 1 + rnd(6), "grading.comment_chars": 200 + rnd(800) });
      if (rnd(25) === 0) await g.__failAt(1 + rnd(12));
      try {
        const op = rnd(10);
        if (op < 6) {
          const comment = rnd(3) === 0 ? null : rnd(2) ? { text: "c".repeat(rnd(900)), reason: "r".repeat(rnd(50)), anchors: rnd(2) ? ["a1"] : [] } : undefined;
          const body = grade({ ...k, base_rev: rnd(8) === 0 ? 0 : await revOf(k), adjust_c: rnd(100) });
          if (comment !== undefined) body.comment = comment;
          await g.grade(E(), body);
        } else if (op < 8) await g.ungrade(E(), { ...k, base_rev: await revOf(k) });
        else if (op < 9) {
          const v = await g.rubric(E(), k.question);
          await g.rubricWrite(E(), { question: k.question, base_rev: v.rev, op: rnd(2) && v.items.length ? { retire: { slot: rnd(v.items.length) } } : { add: { label: "i", points_c: rnd(200) - 100 } } });
        } else {
          const v = await g.choice(E(), member);
          await g.choose(E(), { member, cid: rnd(2) ? cid : null, base_rev: v?.rev ?? 0 });
        }
      } catch {
        crashes++;
      }
      await g.__failAt(0);
    }
    const s = await g.__g2();
    const r = await g.__recountG2();
    ok(s.grades_charged === r.grades_charged && s.comment_charged === r.comment_charged, `invariant: after ${N} random operations (${crashes} crashed)`, js({ s, r }));
    ok(crashes > 0, "invariant: the run included crashes", String(crashes));
  }

  // ---------------------------------------------------------------------------
  // addendum A1 r5: specs in the Gradebook, and recorded hydration outcomes
  {
    const g = fresh();
    await g.collectionSealed(g1env(), cji({ cid: "a1", member: "m1" }));
    await g.collectionSealed(g1env(), { ...cji({ cid: "b1", member: "m2" }), binding: { aid: "aid-1", assignment_rev: 4, bundle_sha: hx("d") } });
    const A = hx("b"), B = hx("d");
    const ga = (o = {}) => grade({ member: "m1", cid: "a1", ...o });
    // A1.3: a missing spec is spec_needed, nothing written
    let s0 = await g.__g2();
    ok(js(await g.grade(E(), ga())) === js({ spec_needed: { bundle_sha: A } }), "A1.3: no specs row gives spec_needed");
    ok(js(await g.__g2()) === js(s0), "A1.3: spec_needed writes nothing");
    // A1.2: widths and prerequisites
    // (padded with "_", which no base-36 digit is, so the ids stay distinct)
    const pairs = (n, w = 2, p = 100) => Array.from({ length: n }, (_, i) => [("q" + i.toString(36)).padEnd(w, "_"), p]);
    ok(js(await g.spec_put(g1env(), hx("e"), [["q1", 1]])).includes("no_collection"), "spec_put: a bundle no collection has");
    ok(js(await g.spec_put(g1env(), A, pairs(101))).includes("invalid"), "spec_put: 101 pairs refused");
    ok(js(await g.spec_put(g1env(), A, [])).includes("invalid"), "spec_put: an empty list");
    ok(js(await g.spec_put(g1env(), A, [["q".padEnd(33, "x"), 1]])).includes("invalid"), "spec_put: a 33-character id");
    ok(js(await g.spec_put(g1env(), A, [["q1", 1_000_001]])).includes("invalid"), "spec_put: points over 1,000,000");
    ok(js(await g.spec_put(g1env(), A, [["q1", 1], ["q1", 2]])).includes("invalid"), "spec_put: a duplicate id");
    ok(js(await g.spec_put({ course_epoch: 1, extra: 1 }, A, [["q1", 1]])).includes("invalid"), "spec_put: G1's envelope only");
    s0 = await g.__g2();
    ok(s0.specs === 0 && s0.grades_charged === 1024, "spec_put: refusals write nothing", js(s0));
    // the widest accepted: 100 pairs of 32-character ids, points 0 and 1,000,000
    const wide = pairs(100, 32, 1_000_000);
    wide[0][1] = 0;
    ok(js(await g.spec_put(g1env(), B, wide)) === js({ ok: { rev: 0 } }), "spec_put: 100 pairs of 32-character ids, points 0..1,000,000");
    ok(js(await g.spec_put(g1env(), A, [["q1", 400], ["q2", 600]])) === js({ ok: { rev: 0 } }), "spec_put: ok");
    let s = await g.__g2();
    ok(s.specs === 2 && s.grades_charged === 1024 + 2 * SPEC, "spec_put: each row charged 8,192 B", js(s));
    ok(js(await g.spec_put(g1env(), A, [["q1", 400], ["q2", 600]])) === js({ ok: { rev: 0 } }) && js(await g.__g2()) === js(s), "spec_put: an identical repeat is ok and writes nothing");
    // A1.3 against each collection's own bundle: q2 is A's, not B's
    ok(okRev(await g.grade(E(), ga({ question: "q2" }))) > 0, "A1.3: a question of the collection's own spec");
    ok(js(await g.grade(E(), grade({ member: "m2", cid: "b1", question: "q2" }))).includes("not a question of this collection's spec"), "A1.3: the same id isn't in the other bundle's spec");
    ok(js(await g.grade(E(), ga({ question: "q9" }))).includes("not a question"), "A1.3: an unknown question");
    // A1.1 r3: a mismatch marks the row integrity_failed; the grade write is then refused
    ok(js(await g.spec_put(g1env(), A, [["q1", 999]])) === js({ invalid: { reason: "spec_mismatch" } }), "spec_put: a different spec is spec_mismatch");
    ok(js(await g.grade(E(), ga({ question: "q1" }))) === js({ spec_integrity: { bundle_sha: A } }), "A1.3: an integrity_failed spec admits no grade");
    s = await g.__g2();
    ok(s.specs === 2 && s.grades_charged === 1024 + 2 * SPEC + 1024, "spec_put: the mismatch kept the first row and charged nothing", js(s));
    ok(js(await g.spec_put(g1env(), A, [["q1", 400], ["q2", 600]])) === js({ ok: { rev: 0 } }) && js(await g.grade(E(), ga({ question: "q1" }))) === js({ spec_integrity: { bundle_sha: A } }), "spec_put: integrity_failed stays for the epoch, even after an identical put");
    await invariant(g, "specs");
  }
  {
    // A1.4: specs_per_placement at the cap and one past; a lowered cap deletes nothing
    const g = fresh();
    for (let i = 0; i < 3; i++) await g.collectionSealed(g1env(), { ...cji({ cid: `c${i}`, member: "m1", n: i + 1 }), binding: { aid: "aid-1", assignment_rev: i + 1, bundle_sha: hx(String(i)) } });
    await g.configure(1, { "grading.specs_per_placement": 2 });
    ok(okRev(await g.spec_put(g1env(), hx("0"), [["q1", 1]])) === 0 && okRev(await g.spec_put(g1env(), hx("1"), [["q1", 1]])) === 0, "specs_per_placement: at the cap");
    ok(js(await g.spec_put(g1env(), hx("2"), [["q1", 1]])) === js({ full: { limit: "specs_per_placement" } }), "specs_per_placement: one past is full");
    await g.configure(2, { "grading.specs_per_placement": 1 });
    ok((await g.__g2()).specs === 2 && okRev(await g.spec_put(g1env(), hx("0"), [["q1", 1]])) === 0, "specs_per_placement: lowered deletes nothing; a repeat is still ok");
    await invariant(g, "specs_per_placement");
  }
  {
    // A1.2c: outcomes, their retry rules, and the exact net of A1 r5
    const g = fresh();
    await g.__clock(1_000_000);
    for (let i = 0; i < 4; i++) await g.collectionSealed(g1env(), { ...cji({ cid: `c${i}`, member: "m1", n: i + 1 }), binding: { aid: "aid-1", assignment_rev: i + 1, bundle_sha: hx(String(i)) } });
    const gc = (i) => grade({ member: "m1", cid: `c${i}` });
    // unreadable: backoff 1 min, doubling
    ok(js(await g.spec_outcome(g1env(), hx("0"), "unreadable", "")) === js({ ok: { rev: 0 } }), "spec_outcome: recorded");
    ok(js(await g.grade(E(), gc(0))) === js({ spec_unavailable: { bundle_sha: hx("0"), reason: "retry_later" } }), "outcome: unreadable within its backoff is retry_later");
    await g.__clock(1_000_000 + 60_000);
    ok(js(await g.grade(E(), gc(0))) === js({ spec_needed: { bundle_sha: hx("0") } }), "outcome: unreadable is due after 1 min");
    await g.spec_outcome(g1env(), hx("0"), "unreadable", "");
    await g.__clock(1_000_000 + 60_000 + 60_000);
    ok(js(await g.grade(E(), gc(0))).includes("retry_later"), "outcome: the second backoff is 2 min");
    // invalid_spec: never retried in the epoch
    await g.spec_outcome(g1env(), hx("1"), "invalid_spec", "");
    await g.__clock(10 ** 12);
    ok(js(await g.grade(E(), gc(1))) === js({ spec_unavailable: { bundle_sha: hx("1"), reason: "invalid_spec" } }), "outcome: invalid_spec is never due");
    // full{specs_per_placement}: due only after a newer limits record
    await g.spec_outcome(g1env(), hx("2"), "full", "specs_per_placement");
    ok(js(await g.grade(E(), gc(2))) === js({ spec_unavailable: { bundle_sha: hx("2"), reason: "specs_per_placement" } }), "outcome: full{specs_per_placement} waits");
    await g.configure(7, {});
    ok(js(await g.grade(E(), gc(2))) === js({ spec_needed: { bundle_sha: hx("2") } }), "outcome: due after a newer limits record");
    // a successful put deletes the outcome row and releases its 256 B, netting 7,936 B (A1 r5)
    let s = await g.__g2();
    ok(okRev(await g.spec_put(g1env(), hx("2"), [["q1", 100]])) === 0, "spec_put: ok over an outcome row");
    let s2 = await g.__g2();
    ok(s2.spec_outcomes === s.spec_outcomes - 1 && s2.grades_charged === s.grades_charged + 7936, "spec_put: deletes the outcome row, net 7,936 B", js({ s, s2 }));
    await invariant(g, "outcomes");
  }
  {
    // A1 r5's boundary: full{grades_bytes} is due at exactly 7,936 B of room, not at 7,934
    // (charges are all even, so a room of 7,935 B can't occur)
    const g = fresh();
    for (let i = 0; i < 2; i++) await g.collectionSealed(g1env(), { ...cji({ cid: `c${i}`, member: "m1", n: i + 1 }), binding: { aid: "aid-1", assignment_rev: i + 1, bundle_sha: hx(String(i)) } });
    const LIMIT = 4 * 2 ** 20;
    await g.configure(1, { "grading.grades_bytes": LIMIT, "grading.comment_bytes": 2 ** 20, "grading.comment_chars": 16000 });
    await g.spec_put(g1env(), hx("0"), [["q1", 1], ["q2", 1]]);
    await g.spec_outcome(g1env(), hx("1"), "full", "grades_bytes");
    // fill with rubric items, then one comment sized to leave exactly 7,934 B
    let q = 0, slot = 0, rev = 0;
    for (;;) {
      const st = await g.__g2();
      if (st.grades_charged + 8448 > LIMIT - 20000) break;
      const a = await g.rubricWrite(E(), { question: `r${q}`, base_rev: rev, op: { add: { label: "x", points_c: 1 } } });
      rev = a.ok.rev;
      if (++slot === 32) [q, slot, rev] = [q + 1, 0, 0];
    }
    const k0 = { member: "m1", question: "q1", cid: "c0" };
    const C0 = 1024 + 2 * (2 + k0.member.length + k0.question.length + k0.cid.length);
    let st = await g.__g2();
    const room = LIMIT - st.grades_charged;
    const len = (room - 1024 - 7934 - C0) / 2;
    const w = await g.grade(E(), grade({ ...k0, comment: { text: "x".repeat(len), reason: "", anchors: [] } }));
    st = await g.__g2();
    ok(okRev(w) > 0 && LIMIT - st.grades_charged === 7934, "boundary: 7,934 B of room", js({ room, len, st }));
    const gc1 = grade({ member: "m1", cid: "c1" });
    ok(js(await g.grade(E(), gc1)) === js({ spec_unavailable: { bundle_sha: hx("1"), reason: "grades_bytes" } }), "boundary: at 7,934 B, full{grades_bytes} isn't due");
    // shrink the comment by one character: 2 B more room, exactly 7,936
    const w2 = await g.grade(E(), grade({ ...k0, base_rev: okRev(w), comment: { text: "x".repeat(len - 1), reason: "", anchors: [] } }));
    st = await g.__g2();
    ok(okRev(w2) > 0 && LIMIT - st.grades_charged === 7936, "boundary: 7,936 B of room after shrinking a comment, with no limits change");
    ok(js(await g.grade(E(), gc1)) === js({ spec_needed: { bundle_sha: hx("1") } }), "boundary: at 7,936 B the outcome is due");
    ok(okRev(await g.spec_put(g1env(), hx("1"), [["q1", 1]])) === 0, "boundary: the put fits exactly");
    st = await g.__g2();
    ok(st.grades_charged === LIMIT && st.spec_outcomes === 0, "boundary: it lands at exactly grades_bytes, the outcome's 256 B released", js(st));
    await invariant(g, "the A1 r5 boundary");
  }
  {
    // the A1 Course-only calls are fenced
    const g = await setup();
    await g.teardown(5, "purge-spec");
    let t;
    do t = await g.teardown(5, "purge-spec");
    while (t.more);
    ok(js(await g.spec_put(g1env(), hx("b"), [["q1", 1]])) === js({ purged: true }), "spec_put: purged below the floor");
    ok(js(await g.spec_outcome(g1env(), hx("b"), "retry", "")) === js({ purged: true }), "spec_outcome: purged below the floor");
  }

  // ---------------------------------------------------------------------------
  // review fixes on b10ef3ed
  {
    // CORR-CLOUD14-1 (astra2): a terminal invalid_spec survives late failures from older hydrations
    const g = fresh();
    await g.__clock(1_000_000);
    await g.collectionSealed(g1env(), { ...cji({ cid: "c0", member: "m1" }), binding: { aid: "aid-1", assignment_rev: 1, bundle_sha: hx("0") } });
    await g.spec_outcome(g1env(), hx("0"), "invalid_spec", "");
    const stuck = js({ spec_unavailable: { bundle_sha: hx("0"), reason: "invalid_spec" } });
    ok(js(await g.grade(E(), grade({ cid: "c0" }))) === stuck, "CORR-CLOUD14-1: invalid_spec recorded");
    const s0 = await g.__g2();
    ok(js(await g.spec_outcome(g1env(), hx("0"), "retry", "")) === js({ ok: { rev: 0 } }), "CORR-CLOUD14-1: a late retry outcome is answered ok");
    ok(js(await g.spec_outcome(g1env(), hx("0"), "unreadable", "")) === js({ ok: { rev: 0 } }), "CORR-CLOUD14-1: a late unreadable outcome is answered ok");
    ok(js(await g.__g2()) === js(s0), "CORR-CLOUD14-1: and neither writes anything");
    for (const at of [1_000_000 + 61_000, 1_000_000 + 3_600_000 * 5, 10 ** 13]) {
      await g.__clock(at);
      ok(js(await g.grade(E(), grade({ cid: "c0" }))) === stuck, `CORR-CLOUD14-1: still invalid_spec at t=${at}`);
    }
    // (success still wins over a recorded outcome: a put deletes it)
    await g.collectionSealed(g1env(), { ...cji({ cid: "c1", member: "m1", n: 2 }), binding: { aid: "aid-1", assignment_rev: 2, bundle_sha: hx("1") } });
    await g.spec_outcome(g1env(), hx("1"), "retry", "");
    ok(okRev(await g.spec_put(g1env(), hx("1"), [["q1", 1]])) === 0 && (await g.__g2()).spec_outcomes === 1, "a put still replaces a non-terminal outcome");
    await invariant(g, "CORR-CLOUD14-1");
  }
  {
    // CORR-CLOUD14-2 (astra2): an explicit null in a rubric edit is refused, and changes nothing
    const g = await setup();
    const r1 = okRev(await g.rubricWrite(E(), { question: "q1", base_rev: 0, op: { add: { label: "original", description: "d", points_c: 123 } } }));
    const before = js(await g.rubric(E(), "q1"));
    const s0 = js(await g.__g2());
    for (const f of ["label", "description", "points_c"]) {
      const a = await g.rubricWrite(E(), { question: "q1", base_rev: r1, op: { edit: { slot: 0, [f]: null } } });
      ok(js(a).includes("invalid") && js(a).includes(f), `CORR-CLOUD14-2: edit ${f}: null is invalid`, js(a));
    }
    ok(js(await g.rubricWrite(E(), { question: "q1", base_rev: r1, op: { edit: { slot: 0, label: null, description: null, points_c: null } } })).includes("invalid"), "CORR-CLOUD14-2: all three null");
    ok(js(await g.rubricWrite(E(), { question: "q1", base_rev: r1, op: { add: { label: "x", points_c: 1, description: null } } })).includes("invalid"), "CORR-CLOUD14-2: add with description null");
    ok(js(await g.rubric(E(), "q1")) === before && js(await g.__g2()) === s0, "CORR-CLOUD14-2: the rubric, rev_seq and counters are unchanged");
    // absent fields keep their values
    ok(okRev(await g.rubricWrite(E(), { question: "q1", base_rev: r1, op: { edit: { slot: 0, label: "renamed" } } })) > r1, "edit: only the label");
    const it = (await g.rubric(E(), "q1")).items[0];
    ok(it.label === "renamed" && it.description === "d" && it.points_c === 123, "edit: absent fields are preserved", js(it));
  }
  {
    // LIMIT-CLOUD14-1 (daybreak3): the prerequisite lookup is an index seek
    const g = await setup();
    const plan = (await g.__plan("SELECT 1 FROM collections WHERE bundle_sha = x'00' LIMIT 1")).join(" | ");
    ok(/USING (COVERING )?INDEX collections_bundle/.test(plan), "LIMIT-CLOUD14-1: collections_bundle serves the lookup", plan);
  }
  {
    // LIMIT-CLOUD14-2 (daybreak3): full{grades_bytes} not due at exactly 7,935 B of room, due at
    // 7,936 B, and the put then lands exactly at grades_bytes. An odd grades_bytes makes the odd room.
    const g = fresh();
    for (let i = 0; i < 2; i++) await g.collectionSealed(g1env(), { ...cji({ cid: `c${i}`, member: "m1", n: i + 1 }), binding: { aid: "aid-1", assignment_rev: i + 1, bundle_sha: hx(String(i)) } });
    const LIMIT = 4 * 2 ** 20 + 1;
    await g.configure(1, { "grading.grades_bytes": LIMIT, "grading.comment_bytes": 2 ** 20, "grading.comment_chars": 16000 });
    await g.spec_put(g1env(), hx("0"), [["q1", 1], ["q2", 1]]);
    await g.spec_outcome(g1env(), hx("1"), "full", "grades_bytes");
    let q = 0, slot = 0, rev = 0;
    for (;;) {
      const st = await g.__g2();
      if (st.grades_charged + 8448 > LIMIT - 20000) break;
      rev = (await g.rubricWrite(E(), { question: `r${q}`, base_rev: rev, op: { add: { label: "x", points_c: 1 } } })).ok.rev;
      if (++slot === 32) [q, slot, rev] = [q + 1, 0, 0];
    }
    const k0 = { member: "m1", question: "q1", cid: "c0" };
    const C0 = 1024 + 2 * (2 + k0.member.length + k0.question.length + k0.cid.length);
    let st = await g.__g2();
    const len = (LIMIT - st.grades_charged - 1024 - 7935 - C0) / 2;
    ok(Number.isInteger(len), "boundary: the sizing comment's length is whole", String(len));
    okRev(await g.grade(E(), grade({ ...k0, comment: { text: "x".repeat(len), reason: "", anchors: [] } })));
    st = await g.__g2();
    ok(LIMIT - st.grades_charged === 7935, "LIMIT-CLOUD14-2: exactly 7,935 B of room", js(st));
    const gc1 = grade({ member: "m1", cid: "c1" });
    ok(js(await g.grade(E(), gc1)) === js({ spec_unavailable: { bundle_sha: hx("1"), reason: "grades_bytes" } }), "LIMIT-CLOUD14-2: at 7,935 B, full{grades_bytes} isn't due");
    await g.configure(2, { "grading.grades_bytes": LIMIT + 1, "grading.comment_bytes": 2 ** 20, "grading.comment_chars": 16000 });
    ok(js(await g.grade(E(), gc1)) === js({ spec_needed: { bundle_sha: hx("1") } }), "LIMIT-CLOUD14-2: at 7,936 B it is due");
    ok(okRev(await g.spec_put(g1env(), hx("1"), [["q1", 1]])) === 0, "LIMIT-CLOUD14-2: the put is ok");
    st = await g.__g2();
    ok(st.grades_charged === LIMIT + 1 && st.spec_outcomes === 0, "LIMIT-CLOUD14-2: it lands exactly at grades_bytes", js(st));
    await invariant(g, "LIMIT-CLOUD14-2");
  }

  // ---------------------------------------------------------------------------
  // grades-size (§8): maximum-width rows of every G2 table, tombstones included, beside G1's
  // members with their handles; physical ≤ the sum of charges
  async function gradesSize(members, per, label) {
    const g = fresh();
    const commentChars = 4000;
    const ceiling = label === "ceiling";
    // maximal comments fill comment_bytes (64 MiB at the defaults, 768 MiB at the ceiling), one
    // per member while they fit; every other grade row is a tombstone
    const maxCharge = 1024 + 2 * (3 * commentChars + 600 + (2 + 8 * (2 + 3 * 128) + 7) + 160);
    let left = Math.floor((ceiling ? 768 : 64) * 2 ** 20 / maxCharge);
    const fixed = { items: ceiling ? 6400 : 960, questions: ceiling ? 6400 : 960 };
    const step = 250;
    let first = true;
    for (let m = 0; m < members; m += step) {
      const n = Math.min(step, members - m);
      await g.__fill(n, 1, 1, m);
      const take = Math.min(n, left);
      left -= take;
      const base = { per, commentChars, epoch: 1, items: 0, questions: 0, fixed: false };
      if (take) await g.__fillG2({ ...base, members: take, start: m, withComment: 1, ...(first ? { ...fixed, fixed: true } : {}) }), (first = false);
      if (n - take) await g.__fillG2({ ...base, members: n - take, start: m + take, withComment: 0, ...(first ? { ...fixed, fixed: true } : {}) }), (first = false);
    }
    const stats = await g.__stats();
    const g1 = await g.__rows();
    const g2 = await g.__g2();
    const charged = g1.charged_bytes + g2.grades_charged;
    ok(stats.size <= charged, `grades-size ${label}: ${stats.size} B physical ≤ ${charged} B charged`);
    ok(g2.comments > 0 && g2.comment_charged <= (ceiling ? 768 : 64) * 2 ** 20, `grades-size ${label}: maximal comments within comment_bytes`, js(g2));
    console.log(`grades-size ${label} ${members} x ${per}: physical ${stats.size} B, charged ${charged} B (${(stats.size / charged).toFixed(3)}), G2 ${js(g2)}`);
  }
  if (process.env.G2_SIZE !== "0") await gradesSize(5000, 60, "defaults");
  if (process.env.GRADES_CEILING === "1") await gradesSize(20000, 160, "ceiling");
}
