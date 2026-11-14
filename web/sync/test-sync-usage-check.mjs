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
  assert.match(sqls[0].sql, /SUM\(claim_bytes\).*state <> 'purged'/);
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

test("storage counts every claim not yet purged: a delete still running (stalled before its purge) keeps its claim", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE sync_accounts (account_hash TEXT PRIMARY KEY, prefix TEXT, generation INTEGER, state TEXT, created INTEGER, claim_bytes INTEGER NOT NULL DEFAULT 0)");
  const now = Date.UTC(2026, 10, 14), sec = Math.floor(now / 1000);
  const add = db.prepare("INSERT INTO sync_accounts VALUES (?, ?, 1, ?, ?, ?)");
  add.run("a", "a", "active", sec, 10);
  add.run("d", "d", "deleting", sec - 5 * 86400, 100);
  add.run("p", "p", "purged", sec - 9 * 86400, 0);
  const api = { d1: async (_db, sql, params) => [{ results: [db.prepare(sql).get(...params)] }], workerDay: async () => ({ requests: 0, egressBytes: 0 }) };
  const f = await readFigures({ api, d1: "x", worker: "x", now });
  assert.equal(f.storageBytes, 110, "the active claim and the stalled delete's");
  assert.equal(f.registrations, 1, "today's registration, in seconds");
});

test("the exit code, as the alert reads it: the script run as a process, Cloudflare's API stood in for", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const script = fileURLToPath(new URL("../../scripts/sync-usage-check.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "usage-check-"));
  // (the stand-in: fetch replaced before the script runs, answering only Cloudflare's two endpoints, from FAKE_CF)
  const pre = join(dir, "fake-fetch.mjs");
  writeFileSync(pre, `const o = JSON.parse(process.env.FAKE_CF);
globalThis.fetch = async (url, init) => {
  const u = String(url), body = JSON.parse(init.body);
  if (u.startsWith("https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query")) {
    const n = body.sql.includes("SUM(claim_bytes)") ? o.storage : o.registrations;
    return Response.json({ success: true, result: [{ results: [{ n }] }] });
  }
  if (u === "https://api.cloudflare.com/client/v4/graphql") return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: o.requests, responseBodySize: o.egress } }] }] } } });
  throw new Error("not Cloudflare's API: " + u);
};
`);
  const run = (fake, args = [], drop = null) => {
    const env = { PATH: process.env.PATH, FAKE_CF: JSON.stringify({ storage: 10, registrations: 3, requests: 100, egress: 2000, ...fake }), CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok", SYNC_D1_ID: "db", SYNC_WORKER: "sync" };
    if (drop) delete env[drop];
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(pre).href, script, ...args], { env, encoding: "utf8", timeout: 30_000 });
    let out = null;
    try { out = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch {}
    return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
  };
  try {
    const within = run({});
    assert.equal(within.code, 0, within.stdout + within.stderr);
    assert.deepEqual(within.out.over, []);
    assert.equal(within.out.registrations, 3);
    const over = run({ registrations: THRESHOLDS.registrationsPerDay + 1 });
    assert.equal(over.code, 2, over.stdout + over.stderr);
    assert.deepEqual(over.out.over, ["registrations"]);
    const big = THRESHOLDS.storageGrowthBytes + 2 ** 30;
    assert.equal(run({ storage: big }).code, 2, "storage over its growth from 0");
    assert.equal(run({ storage: big }, ["--baseline-bytes", String(2 ** 31)]).code, 0, "…within it from the baseline");
    const unreadable = run({ storage: null });
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.out.error, /storage unreadable/);
    assert.equal(run({}, ["--baseline-bytes", "x"]).code, 1, "a baseline that isn't a number");
    const missing = run({}, [], "SYNC_D1_ID");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /missing SYNC_D1_ID/);
    assert.ok(![within, over, unreadable, missing].some((r) => (r.stdout + r.stderr).includes("tok\"") || /Bearer/.test(r.stdout + r.stderr)), "the token never printed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
