// ci: web-sync.1 order=26
// The daily sync usage check (scripts/sync-usage-check.mjs): its figures from D1 and Workers analytics, its thresholds,
// and a figure it can't read never taken as within.  Offline: Cloudflare's API answered by a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFigures, overs, cloudflare, figure, THRESHOLDS } from "../../scripts/sync-usage-check.mjs";

function fakeCloudflare({ storage = 10, registrations = 3, requests = 100, egress = 2000, fail = null, gql = null } = {}) {
  const seen = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, auth: init.headers.authorization });
    if (fail === "d1" && url.includes("/d1/")) return new Response("{}", { status: 500 });
    if (url.includes("/d1/")) {
      const n = body.sql.includes("SUM(claim_bytes)") ? storage : registrations;
      return Response.json({ success: true, result: [{ results: [{ n }] }] });
    }
    if (fail === "graphql") return Response.json({ errors: [{ message: "no" }] });
    if (gql) return Response.json(gql);
    return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests, responseBodySize: egress } }] }] } } });
  };
  return { api: cloudflare({ account: "acct", token: "tok", fetchFn }), seen };
}

test("the figures: claims of active accounts, registrations of the last day, the Worker's day", async () => {
  const { api, seen } = fakeCloudflare({ storage: 5 << 20, registrations: 7, requests: 1234, egress: 99 });
  const now = Date.UTC(2026, 10, 14);
  const f = await readFigures({ api, d1: "db", worker: "sync", now });
  assert.deepEqual(f, { storageBytes: 5 << 20, registrations: 7, requests: 1234, egressBytes: 99 });
  const sqls = seen.filter((s) => s.url.includes("/d1/")).map((s) => s.body);
  assert.match(sqls[0].sql, /SUM\(claim_bytes\).*state = 'active'/);
  assert.deepEqual(sqls[1].params, [Math.floor((now - 86_400_000) / 1000)]);
  assert.ok(seen.every((s) => s.auth === "Bearer tok"));
});

test("thresholds: within, and each one over", () => {
  const base = { storageBytes: 1 << 30, registrations: 10, requests: 1000, egressBytes: 1 << 20 };
  assert.deepEqual(overs(base, 0), []);
  assert.deepEqual(overs({ ...base, storageBytes: THRESHOLDS.storageGrowthBytes + (1 << 30) + 1 }, 1 << 30), ["storage"]);
  assert.deepEqual(overs({ ...base, storageBytes: THRESHOLDS.storageGrowthBytes + (1 << 30) }, 1 << 30), []);
  assert.deepEqual(overs({ ...base, registrations: THRESHOLDS.registrationsPerDay + 1 }), ["registrations"]);
  assert.deepEqual(overs({ ...base, egressBytes: THRESHOLDS.egressBytesPerDay + 1 }), ["egress"]);
  assert.deepEqual(overs({ ...base, requests: THRESHOLDS.requestsPerDay + 1 }), ["requests"]);
});

test("a figure that can't be read is an error, never within", async () => {
  await assert.rejects(readFigures({ api: fakeCloudflare({ fail: "d1" }).api, d1: "db", worker: "sync" }), /D1 query/);
  await assert.rejects(readFigures({ api: fakeCloudflare({ fail: "graphql" }).api, d1: "db", worker: "sync" }), /Workers analytics/);
  await assert.rejects(readFigures({ api: fakeCloudflare({ storage: -1 }).api, d1: "db", worker: "sync" }), /unreadable/);
});

test("null, missing or wrongly typed figures, and GraphQL errors beside data, are unreadable", async () => {
  const run = (o) => readFigures({ api: fakeCloudflare(o).api, d1: "db", worker: "sync" });
  await assert.rejects(run({ storage: null }), /storage unreadable/);
  await assert.rejects(run({ registrations: "7" }), /registrations unreadable/);
  await assert.rejects(run({ gql: { errors: [{ message: "partly" }], data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 1, responseBodySize: 1 } }] }] } } } }), /errors/);
  await assert.rejects(run({ gql: { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: {} }] }] } } } }), /requests unreadable/);
  await assert.rejects(run({ gql: { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 1, responseBodySize: null } }] }] } } } }), /egress unreadable/);
  await assert.rejects(run({ gql: { data: { viewer: { accounts: [] } } } }), /no rows/);
});

test("a baseline that isn't a finite non-negative number is refused, never a quiet no-alarm", () => {
  const f = { storageBytes: 1e15, registrations: 0, requests: 0, egressBytes: 0 };
  for (const b of [NaN, -1, Infinity, "5"]) assert.throws(() => overs(f, b), /baseline unreadable/);
  assert.equal(figure(0, "x"), 0);
});

test("the requests take the deadline's signal: an aborted check ends, its requests cancelled", async () => {
  const ac = new AbortController();
  const fetchFn = (url, init) => new Promise((_, no) => init.signal.addEventListener("abort", () => no(new Error("aborted")), { once: true }));
  const api = cloudflare({ account: "a", token: "t", fetchFn, signal: ac.signal });
  const p = readFigures({ api, d1: "db", worker: "sync" });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, /aborted/);
});
