// ci: web-sync.9 order=30
// Grading G1 step 2: the Gradebook Durable Object (G1 r5 §3.1–3.2, §3.6, §4.1, §6; G2 r4 §1.3's
// collection_member) in Miniflare, with real Durable Object SQLite, and the Course → Gradebook
// wire (wire-course-gradebook-v1, sha256 4cf9176a…). Synthetic data only.
//
// Needs web/site's dependencies (Miniflare): `cd web/site && npm ci` first, as CI
// does. GRADEBOOK_CEILING=1 adds the gradebook-size fixture at the ceiling scale (640,000
// collections and 640,000 rebuild rows).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
// (cji.ts is bundled by bun, as the Worker is, so how Node would treat a .ts file under core's
// package.json never matters)
const wireJs = join(mkdtempSync(join(tmpdir(), "gradebook-wire-")), "cji.mjs");
writeFileSync(wireJs, execFileSync("bun", ["build", join(here, "cji.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
const { validateCJI, validateRebuilt, validateEnvelope, WireError } = await import(wireJs);
const require = createRequire(join(here, "../../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0;
let passed = 0;
function ok(cond, what, detail = "") {
  if (cond) passed++;
  else {
    failures++;
    console.log("FAIL", what, detail);
  }
}
const js = (x) => JSON.stringify(x);

const script = execFileSync("bun", ["build", join(here, "test-gradebook-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
// (the same options shape web/sync/test-sync.mjs uses)
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    {
      name: "gradebook",
      modules: true,
      script,
      compatibilityDate: "2026-10-01",
      durableObjects: { GRADEBOOK: { className: "Gradebook", useSQLite: true } },
    },
  ],
}));
const ns = await mf.getDurableObjectNamespace("GRADEBOOK", "gradebook");
let placements = 0;
const fresh = () => ns.get(ns.idFromName(`placement-${++placements}`));

// ---------------------------------------------------------------------------
// The wire's vectors (§5 of the contract)

const hx = (c) => c.repeat(64);
const env = (e = 1) => ({ course_epoch: e });
function cji(o = {}) {
  const outcome = o.outcome ?? "verified";
  const base = {
    cid: o.cid ?? "cid-1",
    course_key: "course-k",
    placement_key: "placement-k",
    member: o.member ?? "member-1",
    owner: "owner-k",
    doc: "doc-k",
    n: o.n ?? 1,
    reason: o.reason ?? "deadline",
    d: 1_790_000_000_000,
    rev: { drev: 1, xrev: 0 },
    binding: { aid: "aid-1", assignment_rev: 3, bundle_sha: hx("b") },
    seal: { epoch: 1, at_seq: 10, chain: hx("c"), frozen_head: 12, late: true, outcome, ...(outcome === "verified" ? {} : { reason: o.failure ?? (outcome === "failed_resource" ? "budget" : "invalid_value") }) },
  };
  if (outcome === "verified") Object.assign(base, { value: { sha256: hx("1"), bytes: 100 }, census: { sha256: hx("2"), bytes: 20 }, outputs_digest: hx("3") });
  return base;
}
const triple = (c) => ({ value_sha256: hx(c), census_sha256: hx(c), outputs_digest: hx(c), by: "actor-1", at: 1 });
const code = (f) => {
  try {
    f();
    return "accepted";
  } catch (e) {
    return e instanceof WireError ? e.code : "threw " + e;
  }
};
{
  ok(code(() => validateCJI(cji())) === "accepted", "wire: a verified CJI");
  ok(code(() => validateCJI(cji({ outcome: "failed_resource", failure: "budget" }))) === "accepted", "wire: failed_resource with budget");
  ok(code(() => validateCJI(cji({ outcome: "failed_integrity" }))) === "accepted", "wire: failed_integrity with invalid_value");
  const v = cji();
  delete v.census;
  ok(code(() => validateCJI(v)) === "inconsistent", "wire: a missing hash for verified");
  ok(code(() => validateCJI({ ...cji({ outcome: "failed_resource" }), outputs_digest: hx("3") })) === "inconsistent", "wire: a hash present for a failure");
  ok(code(() => validateCJI({ ...cji(), seal: { ...cji().seal, late: false } })) === "inconsistent", "wire: late inconsistent");
  ok(code(() => validateCJI({ ...cji(), outputs_digest: hx("A") })) === "width", "wire: uppercase hex");
  ok(code(() => validateCJI({ ...cji(), outputs_digest: "a".repeat(63) })) === "width", "wire: 63-character hex");
  ok(code(() => validateCJI({ ...cji(), extra: 1 })) === "unknown_field", "wire: an unknown field");
  ok(code(() => validateCJI({ ...cji(), seal: { ...cji().seal, extra: 1 } })) === "unknown_field", "wire: an unknown nested field");
  ok(code(() => validateCJI({ ...cji(), d: 2 ** 53 })) === "width", "wire: an unsafe integer");
  ok(code(() => validateCJI(cji({ outcome: "failed_resource", failure: "invalid_value" }))) === "enum", "wire: a reason of the wrong outcome");
  ok(code(() => validateCJI({ ...cji(), seal: { ...cji().seal, reason: "budget" } })) === "inconsistent", "wire: a reason on verified");
  ok(code(() => validateCJI({ ...cji(), n: 2 ** 32 })) === "width", "wire: n over u32");
  ok(code(() => validateCJI({ ...cji(), cid: "x".repeat(65) })) === "width", "wire: a key over 64");
  ok(code(() => validateEnvelope({ course_epoch: 1, v: 2 })) === "unknown_field", "wire: an envelope field");
  ok(code(() => validateRebuilt({ cid: "c", state: "built", built: triple("a"), second: triple("b") })) === "unknown_field", "wire: built with a second slot");
  ok(code(() => validateRebuilt({ cid: "c", state: "conflict", first: triple("a"), second: triple("b") })) === "accepted", "wire: conflict");
}

// ---------------------------------------------------------------------------
// collection_sealed (§3.2)

{
  const g = fresh();
  ok(js(await g.collectionSealed(env(), cji())) === js({ ack: true }), "sealed: ack");
  ok(js(await g.collectionSealed(env(), cji())) === js({ ack: true }), "sealed: a duplicate acks");
  ok(js(await g.collectionSealed(env(), { ...cji(), n: 2 })) === js({ invalid: { reason: "duplicate_mismatch" } }), "sealed: a different CJI for a recorded cid is invalid");
  let r = await g.__rows();
  ok(r.collections === 1 && r.members === 1 && r.rebuilds === 0 && r.members_count === 1 && r.charged_bytes === 1024 + 256, "sealed: one row and its counters", js(r));
  ok(js(await g.collectionSealed(env(), { ...cji(), extra: 1 })) === js({ invalid: { reason: "unknown_field" } }), "sealed: invalid writes nothing");
  await g.collectionSealed(env(), cji({ cid: "cid-2", outcome: "failed_resource" }));
  r = await g.__rows();
  ok(r.collections === 2 && r.rebuilds === 1 && r.charged_bytes === 1024 * 3 + 256, "sealed: failed_resource opens its rebuild row, charged", js(r));
  ok(js(await g.collection_member("cid-2")) === js({ member: "member-1" }), "collection_member: found");
  ok(js(await g.collection_member("nope")) === js({ unknown: true }), "collection_member: unknown");
  ok(js(await g.collection_member("x".repeat(65))) === js({ unknown: true }), "collection_member: a too-wide cid is unknown");
}

// limits: full at each, nothing written; a duplicate still acks after a lowered limit
{
  const g = fresh();
  await g.configure(1, { "grading.members_per_placement": 1, "grading.collections_per_member": 2 });
  ok(js(await g.collectionSealed(env(), cji())) === js({ ack: true }), "limits: first");
  ok(js(await g.collectionSealed(env(), cji({ cid: "c-m2", member: "member-2" }))) === js({ full: { limit: "members" } }), "limits: members");
  ok(js(await g.collectionSealed(env(), cji({ cid: "c-2", n: 2 }))) === js({ ack: true }), "limits: second for the member");
  ok(js(await g.collectionSealed(env(), cji({ cid: "c-3", n: 3 }))) === js({ full: { limit: "collections_per_member" } }), "limits: collections_per_member");
  await g.configure(2, { "grading.members_per_placement": 1, "grading.collections_per_member": 1 });
  ok(js(await g.collectionSealed(env(), cji())) === js({ ack: true }), "limits: a duplicate acks below a lowered limit");
  const r = await g.__rows();
  ok(r.collections === 2 && r.members === 1, "limits: nothing written by a full", js(r));
  const c = await g.configure(1, { "grading.members_per_placement": 99 });
  ok(c.version === 2 && c.limits["grading.collections_per_member"] === 1, "limits: an older version is ignored");
  const bad = await g.configure(3, { "grading.collections_per_member": 1.5, "grading.members_per_placement": -1, "grading.gradebook_bytes": 2 ** 40 });
  ok(bad.limits["grading.collections_per_member"] === 8 && bad.limits["grading.members_per_placement"] === 5000 && bad.limits["grading.gradebook_bytes"] === 128 * 2 ** 20, "limits: malformed or out-of-range values are the defaults", js(bad));
}
{
  // gradebook_bytes at its 1 MiB minimum holds 455 worst-case collections (G1 r5 §6.2)
  const g = fresh();
  await g.configure(1, { "grading.gradebook_bytes": 2 ** 20 });
  let n = 0;
  for (; n < 470; n++) {
    const a = await g.collectionSealed(env(), cji({ cid: `c${n}`, member: `m${n}`, outcome: "failed_resource" }));
    if (!a.ack) {
      ok(js(a) === js({ full: { limit: "gradebook_bytes" } }), "limits: gradebook_bytes", js(a));
      break;
    }
  }
  ok(n === 455, "limits: exactly 455 worst-case collections fit 1 MiB", String(n));
}

// a crash inside the delivery transaction leaves neither the row nor its counters
{
  const g = fresh();
  for (const at of [4, 5, 6, 7]) {
    await g.__failAt(at);
    let threw = false;
    try {
      await g.collectionSealed(env(), cji({ outcome: "failed_resource" }));
    } catch {
      threw = true;
    }
    const r = await g.__rows();
    ok(threw && r.collections === 0 && r.rebuilds === 0 && r.members === 0 && r.charged_bytes === 0 && r.members_count === 0, `sealed: a crash at statement ${at} leaves nothing`, js(r));
  }
  await g.__failAt(0);
  ok(js(await g.collectionSealed(env(), cji({ outcome: "failed_resource" }))) === js({ ack: true }), "sealed: the retry after a crash goes through");
}

// ---------------------------------------------------------------------------
// collection_rebuilt (§4.1, §4.4 traces 2, 4, 6)

{
  const g = fresh();
  const built = { cid: "cid-1", state: "built", built: triple("a") };
  ok(js(await g.collectionRebuilt(env(), built)) === js({ retry: { after_ms: 1000 } }), "rebuilt: before its sealed is retry, never ack");
  await g.collectionSealed(env(), cji({ outcome: "failed_resource" }));
  await g.collectionSealed(env(), cji({ cid: "cid-v" }));
  ok(js(await g.collectionRebuilt(env(), { ...built, cid: "cid-v" })) === js({ invalid: { reason: "not_failed_resource" } }), "rebuilt: a verified collection has no rebuild");
  ok(js(await g.collectionRebuilt(env(), built)) === js({ ack: true }), "rebuilt: built");
  ok(js(await g.collectionRebuilt(env(), built)) === js({ ack: true }), "rebuilt: the same built again");
  ok(js(await g.collectionRebuilt(env(), { cid: "cid-1", state: "conflict", first: triple("d"), second: triple("b") })) === js({ invalid: { reason: "conflict_mismatch" } }), "rebuilt: a conflict whose first differs");
  ok(js(await g.collectionRebuilt(env(), { cid: "cid-1", state: "conflict", first: triple("a"), second: triple("b") })) === js({ ack: true }), "rebuilt: conflict");
  ok(js(await g.collectionRebuilt(env(), built)) === js({ ack: true }), "rebuilt: a delayed built after conflict is a no-op ack");
  // a conflict received before a delayed built stays conflict
  const h = fresh();
  await h.collectionSealed(env(), cji({ outcome: "failed_resource" }));
  ok(js(await h.collectionRebuilt(env(), { cid: "cid-1", state: "conflict", first: triple("a"), second: triple("b") })) === js({ ack: true }), "rebuilt: conflict first");
  ok(js(await h.collectionRebuilt(env(), built)) === js({ ack: true }), "rebuilt: then built, a no-op");
}

// ---------------------------------------------------------------------------
// teardown (§3.6)

async function call(g, E, id) {
  await g.__resetStats();
  const a = await g.teardown(E, id);
  const s = await g.__stats();
  return { a, statements: s.statements };
}
{
  const g = fresh();
  await g.__fill(30, 8, 1); // 240 collections and 240 rebuild rows at epoch 1
  for (let i = 0; i < 5; i++) await g.collectionSealed(env(5), cji({ cid: `new-${i}`, member: `nm-${i}` })); // a revived epoch
  let calls = 0;
  let worst = 0;
  let a;
  do {
    const r = await call(g, 3, "purge-A");
    a = r.a;
    worst = Math.max(worst, r.statements);
    calls++;
  } while (a.more && calls < 100);
  ok(js(a) === js({ done: true }), "teardown: ends done", js(a));
  ok(worst <= 16, "teardown: every call ≤ 16 statements", String(worst));
  const r = await g.__rows();
  ok(r.collections === 5 && r.rebuilds === 0 && r.members === 5, "teardown: the newer epoch's rows are untouched", js(r));
  // (LIMIT-PR7-1 / CORR-GB-1: the survivors stay charged; the counters are never reset)
  ok(r.members_count === 5 && r.charged_bytes === 5 * (1024 + 256), "teardown: the survivors' counters are kept (5 members, 6,400 B)", js(r));
  ok(js(await g.__recount()) === js({ members_count: r.members_count, charged_bytes: r.charged_bytes }), "teardown: the counters equal the rows' charges", js(await g.__recount()));
  const before = await g.__rows();
  ok(js((await call(g, 3, "purge-A")).a) === js({ done: true }), "teardown: a repeated call after done answers done");
  ok(js((await call(g, 3, "purge-A2")).a) === js({ stale: true }), "teardown: a second purge of the completed epoch is stale");
  ok(js((await call(g, 2, "purge-old")).a) === js({ stale: true }), "teardown: an older purge is stale");
  ok(js(await g.__rows()) === js(before), "teardown: repeated and stale purges change nothing", js(await g.__rows()));
  ok(js(await g.collectionSealed(env(2), cji({ cid: "late-old" }))) === js({ purged: true }), "teardown: a delivery below the floor is purged");
  ok(js(await g.collectionRebuilt(env(2), { cid: "new-0", state: "built", built: triple("a") })) === js({ purged: true }), "teardown: a rebuilt below the floor is purged");
  ok(js(await g.collection_member("c0".padEnd(64, "~"))) === js({ unknown: true }), "collection_member: unknown after the teardown");
  const plan = (await g.__plan("SELECT course_epoch, cid FROM collections WHERE course_epoch < 3 AND (course_epoch, cid) > (-1, '') ORDER BY course_epoch, cid LIMIT 1000")).join(" | ");
  ok(/collections_epoch/.test(plan) && !/SCAN collections\b(?! USING)/.test(plan), "teardown: pages seek the (course_epoch, cid) index", plan);
}
{
  // admission at the cap after a purge, against the survivors' kept counters
  const g = fresh();
  await g.__fill(20, 4, 1);
  for (let i = 0; i < 3; i++) await g.collectionSealed(env(5), cji({ cid: `rev-${i}`, member: `rm-${i}` }));
  let a;
  let n = 0;
  do a = await g.teardown(3, "purge-cap");
  while (a.more && ++n < 50);
  await g.configure(1, { "grading.members_per_placement": 4 });
  ok(js(await g.collectionSealed(env(5), cji({ cid: "rev-3", member: "rm-3" }))) === js({ ack: true }), "after a purge: a 4th member at a cap of 4");
  ok(js(await g.collectionSealed(env(5), cji({ cid: "rev-4", member: "rm-4" }))) === js({ full: { limit: "members" } }), "after a purge: a 5th member is full");
  const r = await g.__rows();
  await g.configure(2, { "grading.members_per_placement": 20000, "grading.gradebook_bytes": 2 ** 20 });
  // (fill the byte budget to exactly its cap, then one more is full)
  let k = 0;
  let last;
  do last = await g.collectionSealed(env(5), cji({ cid: `b-${k}`, member: `bm-${k++}` }));
  while (last.ack && k < 2000);
  const after = await g.__rows();
  ok(js(last) === js({ full: { limit: "gradebook_bytes" } }) && after.charged_bytes <= 2 ** 20 && after.charged_bytes + 1280 > 2 ** 20, "after a purge: gradebook_bytes binds at its cap", js({ last, after }));
  ok(js(await g.__recount()) === js({ members_count: after.members_count, charged_bytes: after.charged_bytes }), "after a purge: the counters equal the rows' charges", js({ r, after }));
}
{
  // newer deliveries between teardown calls, including for a member with old collections
  const g = fresh();
  await g.__fill(1500, 2, 1); // 3,000 + 3,000 rows: several calls
  const shared = "m0".padEnd(64, "~"); // a member of the old epoch
  ok(js(await g.teardown(3, "purge-mid")) === js({ more: true }), "teardown in progress");
  ok(js(await g.collectionSealed(env(5), cji({ cid: "mid-1", member: shared }))) === js({ ack: true }), "a newer delivery mid-teardown, for an old member");
  ok(js(await g.collectionSealed(env(5), cji({ cid: "mid-2", member: "brand-new", outcome: "failed_resource" }))) === js({ ack: true }), "a newer delivery mid-teardown, for a new member");
  ok(js(await g.collectionSealed(env(2), cji({ cid: "mid-old", member: "x" }))) === js({ purged: true }), "an old-epoch delivery mid-teardown is purged");
  let a;
  let n = 0;
  do a = await g.teardown(3, "purge-mid");
  while (a.more && ++n < 50);
  const r = await g.__rows();
  ok(js(a) === js({ done: true }) && r.collections === 2 && r.rebuilds === 1 && r.members === 2, "the newer rows survive", js(r));
  ok(r.members_count === 2 && r.charged_bytes === 2 * 1024 + 1024 + 2 * 256, "their exact charges remain", js(r));
  ok(js(await g.__recount()) === js({ members_count: r.members_count, charged_bytes: r.charged_bytes }), "the counters equal the rows' charges after a mid-teardown delivery");
  ok(js(await g.collection_member("mid-1")) === js({ member: shared }), "the old member's new collection is still theirs");
}
{
  // pages and statements at a larger scale: 4,000 rows per call at most, 3 pages on the first
  const g = fresh();
  await g.__fill(1000, 8, 1); // 8,000 + 8,000 rows
  const counts = [];
  let a;
  do {
    const before = await g.__rows();
    const r = await call(g, 2, "purge-B");
    const after = await g.__rows();
    counts.push({ rows: before.collections + before.rebuilds - after.collections - after.rebuilds, st: r.statements });
    a = r.a;
  } while (a.more && counts.length < 100);
  ok(counts[0].rows <= 3000 && counts.every((c) => c.rows <= 4000 && c.st <= 16), "teardown: ≤ 4,000 rows and ≤ 16 statements per call; ≤ 3,000 on the first", js(counts.slice(0, 3)));
  const r = await g.__rows();
  ok(r.collections === 0 && r.rebuilds === 0 && r.members === 0 && r.charged_bytes === 0 && r.members_count === 0, "teardown: counters back to zero", js(r));
  // (16,000 rows: 3,000 on the first call, then 4,000 a call, plus the step transitions)
  ok(counts.length <= 6, "teardown: at most 6 calls for 16,000 rows", String(counts.length));
}
{
  // a crash before and after a page's commit: the cursor never passes an uncommitted page
  const g = fresh();
  await g.__fill(500, 4, 1); // 2,000 + 2,000 rows
  await g.teardown(2, "purge-C"); // the first call: the cursor, then 3 pages
  const mid = await g.__rows();
  await g.__failAt(3); // the next call: its state read, then a page whose delete runs and whose state update throws
  let threw = false;
  try {
    await g.teardown(2, "purge-C");
  } catch {
    threw = true;
  }
  const after = await g.__rows();
  ok(threw && after.rebuilds + after.collections === mid.rebuilds + mid.collections && after.charged_bytes === mid.charged_bytes, "teardown: a crashed page rolls back whole", js({ mid, after }));
  await g.__failAt(0);
  let a;
  let n = 0;
  do a = await g.teardown(2, "purge-C");
  while (a.more && ++n < 50);
  const r = await g.__rows();
  ok(js(a) === js({ done: true }) && r.collections === 0 && r.rebuilds === 0 && r.charged_bytes === 0, "teardown: resumes to done after the crash", js(r));
}
{
  // a newer purge replaces an unfinished older one
  const g = fresh();
  await g.__fill(200, 4, 1);
  await g.teardown(2, "purge-D");
  const first = await g.teardown(4, "purge-E");
  ok(first.more === true || first.done === true, "teardown: a newer purge starts", js(first));
  let a;
  let n = 0;
  do a = await g.teardown(4, "purge-E");
  while (a.more && ++n < 50);
  ok(js(a) === js({ done: true }), "teardown: the newer purge finishes");
  ok(js(await g.teardown(2, "purge-D")) === js({ stale: true }), "teardown: the replaced older purge is stale");
}

// ---------------------------------------------------------------------------
// gradebook-size (§3.1): maximum-width rows, every collection failed_resource with its rebuild row

async function sizeFixture(members, per) {
  const g = fresh();
  const step = 500;
  for (let m = 0; m < members; m += step) await g.__fill(Math.min(step, members - m), per, 1, m);
  const s = await g.__stats();
  const charges = members * 256 + members * per * (1024 + 1024);
  ok(s.size <= charges, `gradebook-size: ${members} × ${per}: ${s.size} B physical ≤ ${charges} B charged`);
  console.log(`gradebook-size ${members} x ${per}: physical ${s.size} B, charged ${charges} B (${(s.size / charges).toFixed(3)})`);
}
await sizeFixture(5000, 8);
if (process.env.GRADEBOOK_CEILING === "1") await sizeFixture(20000, 32);

// ---------------------------------------------------------------------------
// G2 step 2: the manual-grading tables, on this Miniflare instance
await (await import("./test-grades.mjs")).run({ fresh, ok, js, cji, hx, env });

await mf.dispose();
console.log(`test-gradebook: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
