// Tests for the sync service (web/sync/, design/sync-server.md), in
// Miniflare with real Durable Objects (SQLite), D1 and R2.
//
//   node web/sync/test-sync.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const SITE = "https://sagebrush.test";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333"; // signed in, never allowlisted
// (the DEV test list, SYNC_TEST_ACCOUNTS: on testlist.test, TL1 is in SYNC_ACCOUNTS, TL2 in SYNC_TEST_ACCOUNTS, TL3 in
// neither; on testonly.test only SYNC_TEST_ACCOUNTS is bound, with TL3)
const TL1 = "7a7a7a7a-0001-4a7a-8a7a-7a7a7a7a7a01", TL2 = "7a7a7a7a-0002-4a7a-8a7a-7a7a7a7a7a02", TL3 = "7a7a7a7a-0003-4a7a-8a7a-7a7a7a7a7a03";
const D = "44444444-4444-4444-8444-444444444444"; // allowlisted; its limits are first asked for while CoCalc is down
const E = "55555555-5555-4555-8555-555555555555"; // allowlisted; nothing pending but what a test makes (alarms)
const F = "66666666-6666-4666-8666-666666666666"; // allowlisted; a fetch of its limits held while a notice lands
const G = "77777777-7777-4777-8777-777777777777"; // allowlisted; an upload outlives its reservation
const H = "88888888-8888-4888-8888-888888888888"; // allowlisted; its first registration in D1 fails
const I = "99999999-9999-4999-8999-999999999999"; // allowlisted; its first enable is held after the account object answers, before D1
const K = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // allowlisted; its first enable is held too, while CoCalc purges it
const L = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // allowlisted; D1 answers held late at the Worker (astra's staging)
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // allowlisted, never synced; CoCalc deletes it while requests are past their session check
const N = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // allowlisted; registering, never in D1, when CoCalc purges it
const O = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0"; // allowlisted; its purge held while another account reuses its request id
const P = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1"; // never synced; the other account
const Q = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2"; // allowlisted; its purge held while its receipt is evicted
const RF = "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3"; // never synced; CoCalc's purge of it can't reach its account object
const S1 = "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4"; // allowlisted, with a file; one purge request id is sent for it and for S2 at once
const S2 = "f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5"; // never synced
// (the one storage budget, §6.1: each has storage_bytes 10,000 unless said)
const T1 = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1"; // a sharing upload and a sync upload at the edge, at once
const T2 = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2"; // documents into the ceiling, then a downgrade
const T3 = "e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3"; // sharing at the edge: release and retry; a lost answer's hold; the purge
const T4 = "e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4"; // storage_bytes 1 MiB: D1 writes per growth
const T5 = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5"; // storage_bytes 1 MiB, production's chunk (4 MiB, so L): the tail below a cap
const T6 = "e6e6e6e6-e6e6-4e6e-8e6e-e6e6e6e6e6e6"; // open holds at the cap
const U1 = "e7e7e7e7-e7e7-4e7e-8e7e-e7e7e7e7e7e7"; // a raise's answer held across a purge and a new generation
const U2 = "e8e8e8e8-e8e8-4e8e-8e8e-e8e8e8e8e8e8"; // a raise's answer held across a downgrade
const U3 = "e9e9e9e9-e9e9-4e9e-8e9e-e9e9e9e9e9e9"; // a batch refused before its forward
const V1 = "eaeaeaea-eaea-4eae-8eae-eaeaeaeaeaea"; // a grant made unusable by a downgrade: given back with no further request
// (after a membership ends, §6.2: retention_days 3, and a day is a second in tests)
const R1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1"; // lapses, then renews inside the window
const R2 = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2"; // lapses past the window
const R3 = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3"; // repeated and late notices
const R4 = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4"; // the clock at the boundary
const W1 = "d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5"; // a purge with more expired reservations than one step takes
const W2 = "d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6"; // the same, the alarm pacing the steps
const Y1 = "d7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7"; // a renewal 1 ms before the deadline
const Y2 = "d8d8d8d8-d8d8-4d8d-8d8d-d8d8d8d8d8d8"; // a renewal at the deadline exactly, its period omitted
const Y3 = "d9d9d9d9-d9d9-4d9d-8d9d-d9d9d9d9d9d9"; // a renewal 1 ms after the deadline, a longer period
const Y4 = "dadadada-dada-4dad-8dad-dadadadadada"; // a lapse notice issued 100 days ago
const X1 = "dbdbdbdb-dbdb-4dbd-8dbd-dbdbdbdbdbdb"; // a plan without sync from the start
const X2 = "dcdcdcdc-dcdc-4dcd-8dcd-dcdcdcdcdcdc"; // a plan that ends between enable and the first batch
const Z0 = "dddddddd-0000-4ddd-8ddd-dddddddddd00"; // turned on while CoCalc is down: nothing cached
const Z1 = "dddddddd-0001-4ddd-8ddd-dddddddddd01"; // a lapse while a claim raise is answered
const P1 = "9a9a9a9a-0001-4a9a-8a9a-9a9a9a9a9a01"; // index ops naming their folder by `parent` (§3)
const P2 = "9a9a9a9a-0002-4a9a-8a9a-9a9a9a9a9a02"; // the client's own wire ops (sync-outbox.ts wireOf), parent and all
const ST1 = "5a5a5a5a-0001-4a5a-8a5a-5a5a5a5a5a01"; // GET /status: never synced, plan with sync
const ST2 = "5a5a5a5a-0002-4a5a-8a5a-5a5a5a5a5a02"; // GET /status: not on the allowlist
const ST3 = "5a5a5a5a-0003-4a5a-8a5a-5a5a5a5a5a03"; // GET /status beside an enable
const ST4 = "5a5a5a5a-0004-4a5a-8a5a-5a5a5a5a5a04"; // GET /status while CoCalc is down
const ST5 = "5a5a5a5a-0005-4a5a-8a5a-5a5a5a5a5a05"; // cold statuses and an enable at once: one CoCalc fetch
const ST6 = "5a5a5a5a-0006-4a5a-8a5a-5a5a5a5a5a06"; // statuses polled through an outage: a fetch per retry gate
const J = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"; // on the seamless Worker only: the hold-enable seam is bound for it there

let failures = 0;
let count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const base = { modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"] };
// (an entry without the test seams' flag, as a deployed one is)
const plainScript = execFileSync("bun", ["build", join(here, "test-noseams-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const PURGE_KEY = "purge-key", LIMITS_KEY = "limits-key";
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY, LIMITS_KEY };
const URL_KEY = "url-key";
const LOSE = "fa17fa17fa17";
// ---- a fake CoCalc: the limits (§6)
const fake = { limits: new Map(), down: false, calls: new Map() };
// (one storage_bytes for sharing and sync together, §6.1)
const sync = (storage, reads) => ({ storage_bytes: storage, max_file_bytes: 50_000, sync: { enabled: true, version_bytes: 1000, read_bytes_per_day: reads } });
fake.limits.set(A, sync(30_000, 60_000));
fake.limits.set(B, sync(1 << 20, 1 << 20));
fake.limits.set(D, sync(1 << 20, 1 << 20));
fake.limits.set(E, sync(1 << 20, 1 << 20));
fake.limits.set(F, { ...sync(1000, 1 << 20), issued: 10 });
fake.limits.set(G, sync(1 << 20, 1 << 20));
fake.limits.set(H, sync(1 << 20, 1 << 20));
fake.limits.set(I, sync(1 << 20, 1 << 20));
fake.limits.set(J, sync(1 << 20, 1 << 20));
fake.limits.set(K, sync(1 << 20, 1 << 20));
fake.limits.set(L, sync(1 << 20, 1 << 20));
fake.limits.set(M, sync(1 << 20, 1 << 20));
fake.limits.set(O, sync(1 << 20, 1 << 20));
fake.limits.set(Q, sync(1 << 20, 1 << 20));
for (const t of [T1, T2, T3]) fake.limits.set(t, sync(10_000, 1 << 20));
fake.limits.set(T4, sync(1 << 20, 1 << 20));
fake.limits.set(T5, sync(1 << 20, 1 << 20));
fake.limits.set(T6, sync(1 << 20, 1 << 20));
for (const u of [U1, U2, U3, V1]) fake.limits.set(u, sync(10_000, 1 << 20));
const plan = (enabled, days = 3) => ({ storage_bytes: 1 << 20, max_file_bytes: 50_000, sync: { enabled, version_bytes: 1000, read_bytes_per_day: 1 << 20, retention_days: days } });
for (const r of [R1, R2, R3, R4, W1, W2, Y1, Y2, Y3, Y4, X2]) fake.limits.set(r, plan(true));
fake.limits.set(X1, plan(false));
fake.limits.set(Z0, sync(1 << 20, 1 << 20));
fake.limits.set(N, sync(1 << 20, 1 << 20)); // (enable asks for the plan first)
for (const st of [ST1, ST2, ST3, ST4, ST5, ST6]) fake.limits.set(st, sync(1 << 20, 1 << 20));
fake.limits.set(Z1, plan(true, 100));
fake.limits.set(P1, sync(1 << 20, 1 << 20));
fake.limits.set(P2, sync(1 << 20, 1 << 20));
fake.limits.set(S1, sync(1 << 20, 1 << 20));
for (const t of [TL1, TL2, TL3]) fake.limits.set(t, sync(1 << 20, 1 << 20)); // (the test list's accounts: enable asks for the plan first)
async function cocalc(req) {
  const u = new URL(req.url);
  if (u.pathname === "/api/v2/sagebrush/limits") {
    // (each account's limits requests, counted as they arrive)
    const who = u.searchParams.get("account_id");
    fake.calls.set(who, (fake.calls.get(who) ?? 0) + 1);
    if (fake.limitsGate) await fake.limitsGate;
    if (fake.down) return new Response("down", { status: 503 });
    const l = fake.limits.get(u.searchParams.get("account_id"));
    return l ? Response.json(l) : Response.json({ error: "no_account" }, { status: 404 });
  }
  return new Response("not found", { status: 404 });
}
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    {
      ...base,
      name: "sync",
      bindings: { ...shareBindings, SYNC_ACCOUNTS: `${A}, ${B},${D},${E},${F},${G},${H},${I},${K},${L},${M},${N},${O},${Q},${S1},${T1},${T2},${T3},${T4},${T5},${T6},${U1},${U2},${U3},${V1},${R1},${R2},${R3},${R4},${W1},${W2},${Y1},${Y2},${Y3},${Y4},${X1},${X2},${Z0},${Z1},${ST1},${ST3},${ST4},${ST5},${ST6},${P1},${P2}`, SYNC_URL_KEY: URL_KEY, FILES_ORIGIN: "https://files.test", SYNC_SITE_ORIGIN: SITE, SYNC_TEST_PIN_MS: "1000", SYNC_TEST_LOSE: LOSE, SYNC_TEST_NO_WORKER_DELETE: "1", SYNC_TEST_FAIL_ENROLL: H, SYNC_TEST_HOLD_ENABLE: `${I},${K}`, SYNC_TEST_FAIL_PURGE: RF },
      durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
      routes: ["sagebrush.test/*", "files.test/*"],
      outboundService: cocalc,
      ratelimits: { SYNC_PREAUTH: { namespace_id: "1001", simple: { limit: 100000, period: 60 } }, SYNC_FILES_LIMIT: { namespace_id: "1003", simple: { limit: 100000, period: 60 } }, SYNC_ADMIN_LIMIT: { namespace_id: "1005", simple: { limit: 100000, period: 60 } } },
    },
    // the user-content Worker's signed reads with a tight per-IP limit, 2 a minute; and one with none
    {
      ...base,
      name: "files-tight",
      bindings: { SYNC_URL_KEY: URL_KEY },
      routes: ["tightfiles.test/*"],
      ratelimits: { SYNC_FILES_LIMIT: { namespace_id: "1004", simple: { limit: 2, period: 60 } } },
    },
    { ...base, name: "files-open", bindings: { SYNC_URL_KEY: URL_KEY }, routes: ["openfiles.test/*"] },
    // every seam's binding, but the entry doesn't turn the seams on
    {
      ...base,
      script: plainScript,
      name: "plain",
      bindings: { ...shareBindings, SYNC_ACCOUNTS: J, SYNC_TEST_PIN_MS: "1000", SYNC_TEST_HOLD_ENABLE: J, SYNC_TEST_FAIL_ENROLL: "nobody" },
      durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
      routes: ["plain.test/*"],
      outboundService: cocalc,
      ratelimits: { SYNC_PREAUTH: { namespace_id: "1007", simple: { limit: 100000, period: 60 } } },
    },
    // sync's bindings, but no pre-authentication limit: off (LIMIT-321-1)
    {
      ...base,
      name: "nolimit",
      bindings: { ...shareBindings, SYNC_ACCOUNTS: A },
      durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
      routes: ["nolimit.test/*"],
    },
    // a tight pre-authentication limit: 3 a minute
    {
      ...base,
      name: "tight",
      bindings: { ...shareBindings, SYNC_ACCOUNTS: A },
      durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
      routes: ["tight.test/*"],
      ratelimits: { SYNC_PREAUTH: { namespace_id: "1002", simple: { limit: 3, period: 60 } }, SYNC_ADMIN_LIMIT: { namespace_id: "1006", simple: { limit: 2, period: 60 } } },
    },
    // the DEV test list (SYNC_TEST_ACCOUNTS), beside the secret list; and the test list alone
    {
      ...base,
      name: "testlist",
      bindings: { ...shareBindings, SYNC_ACCOUNTS: TL1, SYNC_TEST_ACCOUNTS: ` ${TL2} ,` },
      durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
      routes: ["testlist.test/*"],
      outboundService: cocalc,
      ratelimits: { SYNC_PREAUTH: { namespace_id: "1011", simple: { limit: 100000, period: 60 } } },
    },
    {
      ...base,
      name: "testonly",
      bindings: { ...shareBindings, SYNC_TEST_ACCOUNTS: TL3 },
      durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
      routes: ["testonly.test/*"],
      outboundService: cocalc,
      ratelimits: { SYNC_PREAUTH: { namespace_id: "1012", simple: { limit: 100000, period: 60 } } },
    },
    // the same code with no sync bindings, as production is today
    { ...base, name: "prod", bindings: shareBindings, routes: ["prod.test/*"] },
  ],
}));
const db = await mf.getD1Database("SHARE_DB", "sync");
const mig = join(here, "../share/migrations");
for (const m of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
  for (const s of readFileSync(join(mig, m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();

const fetchAt = (origin, path, init = {}) => mf.dispatchFetch(origin + path, { redirect: "manual", ...init });
async function signIn(account_id, origin = SITE) {
  const r = await fetchAt(origin, "/auth/dev", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id }) });
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
}
const post = (session, path, body, extra = {}) => fetchAt(SITE, path, { method: "POST", headers: { cookie: session, origin: SITE, "content-type": "application/json", ...extra }, body: JSON.stringify(body ?? {}) });

/** A socket on the account object, with a queue of the messages it gets. */
async function socket(session, origin = SITE, path = "/api/sync/v1/account") {
  const r = await fetchAt(SITE, path, { headers: { cookie: session, origin, upgrade: "websocket" } });
  if (r.status !== 101) return { status: r.status };
  const ws = r.webSocket;
  ws.accept();
  const queue = [];
  const waiting = [];
  let closed = null;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.findIndex((x) => x.match(m));
    if (w >= 0) waiting.splice(w, 1)[0].resolve(m);
    else queue.push(m);
  });
  ws.addEventListener("close", (e) => (closed = e.code));
  let req = 0;
  const s = {
    status: 101,
    ws,
    queue,
    get closed() { return closed; },
    send: (m) => ws.send(JSON.stringify(m)),
    /** The next message `match` accepts, or null after 3 seconds. */
    next(match = () => true) {
      const i = queue.findIndex(match);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve) => {
        const w = { match, resolve };
        waiting.push(w);
        setTimeout(() => {
          const j = waiting.indexOf(w);
          if (j >= 0) waiting.splice(j, 1), resolve(null);
        }, 3000);
      });
    },
    /** Send a request and wait for its answer (by req). */
    async ask(m) {
      const r = ++req;
      s.send({ ...m, req: r });
      return s.next((x) => x.req === r);
    },
  };
  return s;
}
async function hello(s, device, index_after = 0) {
  s.send({ t: "hello", v: 2, device, name: "test", index_after });
  const w = await s.next((m) => m.t === "welcome" || m.t === "error");
  const ix = await s.next((m) => m.t === "index");
  return { welcome: w, index: ix };
}

// ---- patches: ids, envelopes, bodies
const enc = new TextEncoder();
const pid = (t, client) => t.toString(36).padStart(11, "0") + "_" + client;
/** A batch for `doc`: each patch [cseq, id, parents, payload text, blobs?]. */
function batch(doc, epoch, patches, extra = {}) {
  const bodies = patches.map((p) => enc.encode(p[3] ?? `{"patch":${JSON.stringify(p[1])}}`));
  const body = Buffer.concat(bodies.map((b) => Buffer.from(b)));
  return { t: "batch", doc, epoch, patches: patches.map((p, i) => ({ cseq: p[0], id: p[1], parents: p[2], size: bodies[i].length, ...(p[4] ? { blobs: p[4] } : {}) })), body: body.toString("base64"), ...extra };
}
const payloads = (item) => {
  const b = Buffer.from(item.body, "base64");
  let at = 0;
  return item.patches.map((e) => b.subarray(at, (at += e.size)).toString());
};

// ---- the flag and the gates (§2, §11)
{
  const sp = await signIn(A, "https://prod.test");
  let r = await fetchAt("https://prod.test", "/api/sync/v1/enable", { method: "POST", headers: { cookie: sp, origin: "https://prod.test", "content-type": "application/json" }, body: "{}" });
  ok(r.status === 404 && (await r.json()).error === "sync is not enabled here", "without the sync bindings, sync is a 404 (the flag)");
  // the test seams are off in any Worker not built from the test entry, whatever is bound
  const sj = await signIn(J, "https://plain.test");
  const ej = await fetchAt("https://plain.test", "/api/sync/v1/enable", { method: "POST", headers: { cookie: sj, origin: "https://plain.test", "content-type": "application/json" }, body: "{}" });
  const bj = await ej.json();
  ok(ej.status === 200 && bj.state === "active" && bj.held === undefined, "a Worker without the test entry ignores the seams' bindings: the hold-enable seam bound for this account does nothing");
  const sn = await signIn(A, "https://nolimit.test");
  r = await fetchAt("https://nolimit.test", "/api/sync/v1/enable", { method: "POST", headers: { cookie: sn, origin: "https://nolimit.test", "content-type": "application/json" }, body: "{}" });
  ok(r.status === 404, "with the objects bound but no pre-authentication limit, sync is off too");
  // the limit comes before any session is read: requests with no session get 429, not 401, once it is used up
  await clearOfMinuteEdge();
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetchAt("https://tight.test", "/api/sync/v1/enable", { method: "POST", headers: { origin: "https://tight.test", "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: "{}" })).status);
  ok(codes.join() === "401,401,401,429,429", "the pre-authentication limit is per IP and before the session check: " + codes.join());
  const r429 = await (await fetchAt("https://tight.test", "/api/sync/v1/enable", { method: "POST", headers: { origin: "https://tight.test", "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: "{}" })).json();
  ok(r429.error === "too many requests" && r429.retry_after === 60_000, "and the 429 says how long to wait: the limit's minute (LIMIT-SYNC-STATUS-1): " + JSON.stringify(r429));
  r = await fetchAt("https://tight.test", "/api/sync/v1/enable", { method: "POST", headers: { origin: "https://tight.test", "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" }, body: "{}" });
  ok(r.status === 401, "another IP has its own limit");
  const sa = await signIn(A);
  ok((await post(null, "/api/sync/v1/enable", {})).status === 401, "no session: 401");
  ok((await fetchAt(SITE, "/api/sync/v1/enable", { method: "POST", headers: { cookie: sa, origin: "https://evil.test" } })).status === 403, "a cross-site request is refused");
  const sc = await signIn(C);
  ok((await post(sc, "/api/sync/v1/enable", {})).status === 403, "an account not in SYNC_ACCOUNTS can't turn sync on");
  ok((await socket(sc)).status === 403, "nor open a socket");
  ok((await socket(sa)).status === 403, "a socket before sync is turned on is refused");
  const e = await post(sa, "/api/sync/v1/enable", {});
  ok(e.status === 200 && JSON.stringify(await e.json()) === JSON.stringify({ state: "active", generation: 1 }), "turning sync on: generation 1");
  ok((await post(sa, "/api/sync/v1/enable", {})).status === 200, "again is a no-op");
  ok((await socket(sa, "https://evil.test")).status === 403, "a socket upgrade from another origin is refused (cross-site WebSocket hijacking)");
}

// ---- the DEV test list (SYNC_TEST_ACCOUNTS): allowed() takes an id in either list, nothing else changes
{
  const at = async (origin, id) => {
    const s = await signIn(id, origin);
    const st = await (await fetchAt(origin, "/api/sync/v1/status", { headers: { cookie: s, origin } })).json();
    const en = (await fetchAt(origin, "/api/sync/v1/enable", { method: "POST", headers: { cookie: s, origin, "content-type": "application/json" }, body: "{}" })).status;
    return { allowlisted: st.reason !== "not_allowlisted", available: st.available !== false, enable: en };
  };
  const tl = "https://testlist.test", to = "https://testonly.test";
  const r1 = await at(tl, TL1), r2 = await at(tl, TL2), r3 = await at(tl, TL3);
  ok(r1.allowlisted && r1.enable === 200, "an id in SYNC_ACCOUNTS syncs as before, with the test list bound beside it: " + JSON.stringify(r1));
  ok(r2.allowlisted && r2.enable === 200, "an id only in SYNC_TEST_ACCOUNTS syncs (the list's spaces and empty entries ignored): " + JSON.stringify(r2));
  ok(!r3.allowlisted && !r3.available && r3.enable === 403, "an id in neither list is refused: not_allowlisted, enable 403: " + JSON.stringify(r3));
  const o3 = await at(to, TL3), o1 = await at(to, TL1);
  ok(o3.allowlisted && o3.enable === 200, "the test list alone (no SYNC_ACCOUNTS) allows its own id: " + JSON.stringify(o3));
  ok(!o1.allowlisted && o1.enable === 403, "…and only that id: another environment's SYNC_ACCOUNTS id is refused there: " + JSON.stringify(o1));
}

const sa = await signIn(A);
await post(sa, "/api/sync/v1/enable", {});
const sb = await signIn(B);
await post(sb, "/api/sync/v1/enable", {});

// ---- hello, and ops decided once each in dseq order (§3, §5.2)
const dev1 = "device-one-0001";
const dev2 = "device-two-0002";
{
  const s = await socket(sa);
  ok(s.status === 101, "the account socket opens");
  const { welcome, index } = await hello(s, dev1);
  ok(welcome?.t === "welcome" && welcome.v === 2 && welcome.next_dseq === 1 && welcome.state === "active" && welcome.generation === 1, "welcome, with the generation (for Delete my synced data)");
  ok(index?.t === "index" && index.ops.length === 0 && index.more === false, "an empty index");
  const nb = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const op = (dseq, o) => ({ dseq, t: 1000 + dseq, by: "person", kind: "folder", ...o });
  let a = await s.ask({ t: "ops", ops: [op(1, { op: "mkdir", path: "/A" }), op(2, { op: "create", path: "/A/n.ipynb", kind: "notebook", ref: nb })] });
  ok(a?.t === "ack" && a.ops.length === 2 && a.ops?.[0].seq === 1 && a.ops?.[1].seq === 2, "two ops accepted, in order");
  a = await s.ask({ t: "ops", ops: [op(1, { op: "mkdir", path: "/A" }), op(2, { op: "create", path: "/A/n.ipynb", kind: "notebook", ref: nb })] });
  ok(a?.ops?.[0].seq === 1 && a.ops?.[1].seq === 2, "resent ops get the same answer, and aren't applied twice");
  a = await s.ask({ t: "ops", ops: [op(4, { op: "mkdir", path: "/B" })] });
  ok(a?.t === "error" && a.code === "order" && a.detail.next_dseq === 3, "a gap in dseq is refused with next_dseq");
  a = await s.ask({ t: "ops", ops: [op(3, { op: "mkdir", path: "/x/../y" }), op(4, { op: "forget", path: "/A/n.ipynb", kind: "notebook", by: "agent:helper" }), op(5, { op: "mkdir", path: "/C" })] });
  ok(a?.ops?.[0].code === "invalid" && a.ops?.[1].code === "forbidden" && a.ops?.[2].seq === 3, "a bad path and an agent's forget are refused; the op after them applies");
  a = await s.ask({ t: "ops", ops: [op(3, { op: "mkdir", path: "/x/../y" }), op(4, { op: "mkdir", path: "/Z" })] });
  ok(a?.ops?.[0].code === "invalid" && a.ops?.[1].code === "forbidden", "a refusal is final: the same dseq gets the same refusal, whatever is sent");
  a = await s.ask({ t: "ops", ops: [op(6, { op: "mkdir", path: "/D", extra: 1 })] });
  ok(a?.ops?.[0]?.code === "invalid", "an unknown field in an op is refused");
  a = await s.ask({ t: "pull_index", after: 1 });
  ok(a?.t === "index" && a.ops.map((o) => o.seq).join() === "2,3", "pull_index from a seq");
  const s2 = await socket(sa);
  const h2 = await hello(s2, dev2, 0);
  ok(h2.welcome.next_dseq === 1 && h2.index.ops.length === 3, "another device gets the whole log, and its own dseq");
  const a2 = await s2.ask({ t: "ops", ops: [op(1, { op: "mkdir", path: "/E" })] });
  ok(a2?.ops?.[0].seq === 4, "the server's seq orders both devices' ops");
  s.ws.close();
  s2.ws.close();
}

// ---- batches: exact membership, framing, compare-and-swap (§4.1-4.4)
const docA = "0123456789ab";
{
  const s = await socket(sa);
  await hello(s, dev1);
  const X = "clientXXXX", Y = "clientYYYY";
  let a = await s.ask(batch(docA, 1, [[1, pid(100, X), []]]));
  ok(a?.t === "error" && a.code === "unknown_doc", "a new document's first batch must say its kind");
  a = await s.ask(batch(docA, 1, [[1, pid(100, X), [], "p1"], [2, pid(300, X), [pid(100, X)], "p2"]], { kind: "board" }));
  ok(a?.t === "ack" && a.batch.seq === 1 && a.batch.new === 2 && a.batch.head.seq === 1, "a new board's first batch");
  a = await s.ask(batch(docA, 1, [[1, pid(100, X), [], "p1"], [2, pid(300, X), [pid(100, X)], "p2"]]));
  ok(a?.batch?.new === 0 && a.batch.resent[pid(100, X)] === 1 && a.batch.resent[pid(300, X)] === 1, "a resend is acknowledged with its original seq, and stores nothing");
  // astra's CORR-D81-1 trace: 300_X accepted; a parent 200_X was never sent
  a = await s.ask(batch(docA, 1, [[1, pid(400, Y), [pid(200, X)]]]));
  ok(a?.t === "error" && a.code === "order", "a parent that was never accepted is refused, though its id is below the client's newest");
  a = await s.ask(batch(docA, 1, [[3, pid(200, X), []]]));
  ok(a?.t === "error" && a.code === "order", "a client's next patch can't have a smaller id than its last");
  a = await s.ask(batch(docA, 1, [[2, pid(250, X), []]]));
  ok(a?.t === "error" && a.code === "conflict", "a cseq reused for another patch is refused, never taken as a resend");
  a = await s.ask(batch(docA, 1, [[4, pid(500, X), []]]));
  ok(a?.t === "error" && a.code === "order" && a.detail.next_cseq === 3, "a gap in cseq is refused with next_cseq");
  // a mixed resend: the old patch is dropped, the new one's payload sliced out
  a = await s.ask(batch(docA, 1, [[2, pid(300, X), [pid(100, X)], "p2"], [3, pid(600, X), [pid(300, X)], "p3-new"]]));
  ok(a?.batch?.new === 1 && a.batch.seq === 2 && a.batch.resent[pid(300, X)] === 1, "a mixed resend stores only the new patch");
  let p = await s.ask({ t: "pull", doc: docA, epoch: 1, after: 1 });
  ok(p?.t === "batches" && p.items.length === 1 && p.items[0].patches.length === 1 && payloads(p.items[0])[0] === "p3-new" && p.items[0].author === "person", "its stored batch holds only that patch, with its own payload, and the server's author");
  const bad = batch(docA, 1, [[4, pid(700, X), [], "abc"]]);
  bad.patches[0].size = 2;
  a = await s.ask(bad);
  ok(a?.t === "error" && a.code === "invalid", "envelopes whose sizes don't add up to the body are refused");
  a = await s.ask({ ...batch(docA, 1, [[4, pid(700, X), []]]), author: "agent:x" });
  ok(a?.t === "error" && a.code === "invalid", "a batch can't name its own author");
  // compare-and-swap (CORR-D81-4)
  a = await s.ask(batch(docA, 1, [[1, pid(800, Y), [pid(600, X)], "y1"]], { expect_head: { epoch: 1, seq: 1 } }));
  ok(a?.t === "error" && a.code === "conflict" && a.detail.head.seq === 2, "expect_head behind the head is a conflict");
  a = await s.ask(batch(docA, 1, [[1, pid(800, Y), [pid(600, X)], "y1"]], { expect_head: { epoch: 1, seq: 2 } }));
  ok(a?.batch?.seq === 3, "expect_head at the head commits");
  a = await s.ask(batch(docA, 1, [[1, pid(800, Y), [pid(600, X)], "y1"]], { expect_head: { epoch: 1, seq: 2 } }));
  ok(a?.batch?.new === 0 && a.batch.resent[pid(800, Y)] === 3, "the same write resent after a lost answer gets its seq, not a conflict");
  // a patchflow client belongs to one writer
  const s2 = await socket(sa);
  await hello(s2, dev2);
  a = await s2.ask(batch(docA, 1, [[2, pid(900, Y), [pid(800, Y)]]]));
  ok(a?.t === "error" && a.code === "forbidden", "another device can't write as a client that isn't its own");
  // another device is told of a change
  const changed = s2.next((m) => m.t === "changed");
  a = await s.ask(batch(docA, 1, [[2, pid(900, Y), [pid(800, Y)], "y2"]]));
  const ch = await changed;
  ok(ch?.doc === docA && ch.head.seq === 4 && ch.by_device === dev1, "the account's other sockets hear `changed`");
  // pull's bounds
  p = await s.ask({ t: "pull", doc: docA, epoch: 1, after: 0, limit: 2 });
  ok(p?.items.length === 2 && p.more === true, "pull pages with `more`");
  p = await s.ask({ t: "pull", doc: docA, epoch: 1, after: 0, limit: 10_000 });
  ok(p?.items.length === 4 && p.more === false, "a limit over the maximum is the maximum");
  s.ws.close();
  s2.ws.close();
}

// ---- isolation (§2)
{
  const s = await socket(sb);
  await hello(s, "device-b-000001");
  let a = await s.ask({ t: "pull", doc: docA, epoch: 1, after: 0 });
  ok(a?.t === "error" && a.code === "unknown_doc", "another account can't pull A's document by its id");
  a = await s.ask(batch(docA, 1, [[1, pid(100, "clientBBBB"), [], "b"]], { kind: "board" }));
  ok(a?.t === "ack" && a.batch.seq === 1, "the same id in another account is another document");
  a = await s.ask({ ...batch(docA, 1, [[2, pid(200, "clientBBBB"), [pid(100, "clientBBBB")]]]), owner: "a".repeat(64) });
  ok(a?.t === "error" && a.code === "unknown_doc", "naming another owner reaches nothing");
  s.ws.close();
}

// ---- the epoch: clear history keeps the document (§4.6, CORR-D81-6)
{
  const s = await socket(sa);
  await hello(s, dev1);
  const R = "clientROOT";
  let a = await s.ask({ t: "clear", doc: docA, expect_head: { epoch: 1, seq: 3 }, root: { patches: [{ cseq: 1, id: pid(1000, R), parents: [], size: 4 }], body: Buffer.from("root").toString("base64") } });
  ok(a?.t === "error" && a.code === "conflict", "clear with a stale expect_head is refused");
  a = await s.ask({ t: "clear", doc: docA, expect_head: { epoch: 1, seq: 4 }, root: { patches: [{ cseq: 1, id: pid(1000, R), parents: [pid(900, "clientYYYY")], size: 4 }], body: Buffer.from("root").toString("base64") } });
  ok(a?.t === "error" && a.code === "invalid", "the root has no parents");
  a = await s.ask({ t: "clear", doc: docA, expect_head: { epoch: 1, seq: 4 }, root: { patches: [{ cseq: 1, id: pid(1000, R), parents: [], size: 4 }], body: Buffer.from("root").toString("base64") } });
  ok(a?.t === "ack" && a.batch.head.epoch === 2 && a.batch.seq === 5, "clear: a new epoch, whose first batch is the root");
  s.ws.close();
  // a fresh device, at once
  const f = await socket(sa);
  await hello(f, "device-fresh-01");
  let p = await f.ask({ t: "pull", doc: docA, epoch: 1, after: 0 });
  ok(p?.t === "error" && p.code === "epoch" && p.detail.epoch === 2, "the old epoch can't be pulled");
  p = await f.ask({ t: "pull", doc: docA, epoch: 2, after: 0 });
  ok(p?.items.length === 1 && payloads(p.items[0])[0] === "root", "a fresh device opens the document from its root");
  a = await f.ask(batch(docA, 1, [[3, pid(1100, "clientXXXX"), []]]));
  ok(a?.t === "error" && a.code === "epoch", "a batch of the old epoch is refused, so the old history can't come back");
  a = await f.ask(batch(docA, 2, [[1, pid(1200, "clientNEW1"), [pid(1000, R)], "rebased"]]));
  ok(a?.batch?.seq === 6, "the new epoch takes patches on the root");
  f.ws.close();
}

// ---- the ops rate counts ops, not messages (LIMIT-321-2); messages are bounded in UTF-8 bytes (LIMIT-321-3)
{
  const sd = await signIn(D);
  await post(sd, "/api/sync/v1/enable", {});
  const s = await socket(sd);
  const { welcome } = await hello(s, "device-d-000001");
  let d = welcome.next_dseq;
  const many = (n) => Array.from({ length: n }, () => ({ dseq: d++, t: 1, by: "person", op: "mkdir", path: `/m${d}`, kind: "folder" }));
  let a = await s.ask({ t: "ops", ops: many(500) });
  ok(a?.ops?.length === 500, "500 ops in a message");
  for (let i = 0; i < 3; i++) a = await s.ask({ t: "ops", ops: many(500) });
  ok(a?.ops?.length === 500, "2,000 ops: the whole minute's budget");
  a = await s.ask({ t: "ops", ops: many(100) });
  ok(a?.t === "error" && a.code === "rate" && a.detail.retry_after > 0, "the next 100 ops are over the budget: rate, with retry_after");
  const max = 2 << 20;
  const pad = (n) => JSON.stringify({ t: "x", req: 1, pad: "a".repeat(n) });
  const exact = pad(max - pad(0).length);
  ok(Buffer.byteLength(exact) === max, "(a message of exactly the limit)");
  s.send(JSON.parse(exact));
  const e = await s.next((m) => m.t === "error");
  ok(e?.code === "invalid" && s.closed === null, "a message of exactly 2 MiB is read (and refused only for what it says)");
  // (UTF-16 length under the limit, UTF-8 bytes over it)
  const wide = JSON.stringify({ t: "x", req: 2, pad: "é".repeat(max / 2) });
  ok(wide.length < max && Buffer.byteLength(wide) > max, "(a message under the limit in characters, over it in bytes)");
  s.ws.send(wide);
  await new Promise((r) => setTimeout(r, 500));
  ok(s.closed === 1009, "is closed with 1009: the limit is in UTF-8 bytes");
}

// ---- blobs: upload, reads, pins (§4.3, §5.4)
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** Poll `f` until it is truthy, at most `ms` (alarms run in real time, slower under load): its last value. */
/**
 * Miniflare's rate limits count in fixed windows on the clock (epoch = now / period): a sequence that
 * straddles a minute's edge starts again in a new window, and sees no 429.  So a test of one waits
 * until it has `need` ms of its window left (at most that long).
 */
async function clearOfMinuteEdge(need = 10_000) {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < need) await new Promise((r) => setTimeout(r, left + 50));
}
async function until(f, ms = 15_000) {
  const end = Date.now() + ms;
  let v = await f();
  while (!v && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    v = await f();
  }
  return v;
}
const acctNs = await mf.getDurableObjectNamespace("SYNC_ACCOUNT", "sync");
const hashOf = (id) => createHash("sha256").update("sagebrush-account\n" + id).digest("hex");
// "Delete my synced data", naming the generation the account's record holds (as its device was given it)
const genOf = async (id) => (await db.prepare("SELECT generation FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(id)).first())?.generation;
const del = async (session, id) => post(session, "/api/sync/v1/delete", { confirm: "delete", generation: await genOf(id) });
let acctA = acctNs.get(acctNs.idFromName("acct:" + hashOf(A)));
const put = (session, bytes, h = sha(bytes)) => fetchAt(SITE, `/api/sync/v1/blob/${h}`, { method: "PUT", headers: { cookie: session, origin: SITE, "content-type": "application/octet-stream" }, body: bytes });
const big = Buffer.alloc(6000, 7), small = Buffer.from("small file"), other = Buffer.alloc(6000, 9);
{
  let r = await post(sa, "/api/sync/v1/blobs/check", { blobs: [{ sha256: sha(big), size: big.length }, { sha256: sha(small), size: small.length }] });
  ok(r.status === 200 && (await r.json()).missing.length === 2, "check: both missing");
  r = await post(sa, "/api/sync/v1/blobs/check", { blobs: [{ sha256: sha(big), size: 1, extra: 1 }] });
  ok(r.status === 400, "check: an unknown field is refused");
  r = await put(sa, big);
  ok(r.status === 201 && (await r.json()).sha256 === sha(big), "an upload");
  r = await put(sa, big);
  ok(r.status === 200 && (await r.json()).have === true, "the same bytes again: already held, nothing stored");
  r = await put(sa, small, sha(big).replace(/^./, "0"));
  ok(r.status === 400, "bytes that don't match their SHA-256 are refused by R2");
  let i = await acctA.inspect({ sha256: sha(big) });
  ok(i?.refs === 0 && i.used === 6000, "a held blob counts in usage from its upload; the refused upload gave its reservation back");
  r = await put(sa, Buffer.alloc(60_000, 1));
  ok(r.status === 413, "a file over max_file_bytes is refused");
  r = await put(sa, other);
  ok(r.status === 201, "a second blob");
  r = await put(sa, Buffer.alloc(20_000, 3));
  ok(r.status === 507 && (await r.json()).error === "storage_full", "over storage_bytes: storage_full");
  // a read: debited at issue, a 303 to a signed URL on the user-content domain
  r = await fetchAt(SITE, `/api/sync/v1/blob/${sha(big)}`, { headers: { cookie: sa, "sec-fetch-site": "same-origin" } });
  const loc = r.headers.get("location") ?? "";
  ok(r.status === 303 && loc.startsWith("https://files.test/p/s/"), "a read redirects to a signed URL on the user-content domain");
  r = await fetchAt(SITE, `/api/sync/v1/blob/${sha(big)}`, { headers: { cookie: sa, "sec-fetch-site": "cross-site" } });
  ok(r.status === 403, "a cross-site GET is refused");
  r = await fetchAt(SITE, `/api/sync/v1/blob/${sha(big)}`, { headers: { cookie: await signIn(B), "sec-fetch-site": "same-origin" } });
  ok(r.status === 404, "another account can't read A's blob by its hash");
  const f = await mf.dispatchFetch(loc);
  const body = Buffer.from(await f.arrayBuffer());
  ok(f.status === 200 && body.equals(big) && f.headers.get("content-disposition") === "attachment" && f.headers.get("x-content-type-options") === "nosniff" && f.headers.get("access-control-allow-origin") === SITE && /sandbox/.test(f.headers.get("content-security-policy") ?? ""), "the signed URL serves the bytes as an attachment, nosniff, sandboxed, CORS for the site only");
  const rg = await mf.dispatchFetch(loc, { headers: { range: "bytes=10-19" } });
  ok(rg.status === 206 && (await rg.arrayBuffer()).byteLength === 10, "a range of a device's URL");
  const u = new URL(loc);
  u.searchParams.set("sig", "0".repeat(64));
  ok((await mf.dispatchFetch(u)).status === 403, "a forged signature reads nothing");
  const key = u.pathname.slice(3);
  const exp = Date.now() - 1000;
  const old = new URL(loc);
  old.searchParams.set("exp", String(exp));
  old.searchParams.set("sig", createHmac("sha256", URL_KEY).update(`p\n${key}\n${exp}`).digest("hex"));
  ok((await mf.dispatchFetch(old)).status === 403, "an expired URL reads nothing, though signed");
  // the read budget: 60,000 bytes a day of bytes authorized; 6,000 already
  let n = 1;
  while (n < 20 && (await fetchAt(SITE, `/api/sync/v1/blob/${sha(big)}`, { headers: { cookie: sa, "sec-fetch-site": "same-origin" } })).status === 303) n++;
  ok(n === 10, "the read budget is debited at issue: the tenth 6,000-byte read is refused");
}
// ---- the limits when CoCalc is down (§6): the cache is kept; with nothing cached, uploads wait
{
  fake.down = true;
  let r = await put(sa, Buffer.from("while down"));
  ok(r.status === 201, "CoCalc down: an account with cached limits still uploads");
  // (a fresh account, turned on while CoCalc is down: turning sync on asks for the plan first, and
  // can't, so it isn't turned on at all, never "active" with nothing known)
  const sd = await signIn(Z0);
  const acctZ0 = acctNs.get(acctNs.idFromName("acct:" + hashOf(Z0)));
  const ez = await post(sd, "/api/sync/v1/enable", {});
  const ezb = await ez.json();
  ok(ez.status === 503 && ezb.error === "busy" && /CoCalc can't be reached/.test(ezb.message) && (await acctZ0.lifecycle())?.state === null && (await db.prepare("SELECT 1 AS x FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(Z0)).first()) === null,
    "CoCalc down and nothing known: enable says CoCalc can't be reached, and registers nothing (no row, no state): " + JSON.stringify(ezb));
  r = await put(sd, Buffer.from("d while down"));
  ok(r.status === 403, "and the account takes no upload: sync isn't on");
  fake.down = false;
  await new Promise((r) => setTimeout(r, 600)); // (CoCalc isn't asked again for a moment after it failed: 0.5 s in tests)
  const ez2 = await (await post(sd, "/api/sync/v1/enable", {})).json();
  r = await put(sd, Buffer.from("d while down"));
  ok(ez2.state === "active" && r.status === 201, "once CoCalc answers, enable turns it on, and the upload goes");
}
// ---- an op that names a data file's bytes (§3)
{
  const s = await socket(sa);
  const { welcome } = await hello(s, dev1);
  const d = welcome.next_dseq;
  let a = await s.ask({ t: "ops", ops: [{ dseq: d, t: 1, by: "person", op: "create", path: "/data.csv", kind: "file", fid: "0123456789abcdef", sha256: sha(small), size: small.length }] });
  ok(a?.ops?.[0]?.code === "missing", "an op naming bytes not uploaded is refused");
  a = await s.ask({ t: "ops", ops: [{ dseq: d + 1, t: 1, by: "person", op: "create", path: "/big.bin", kind: "file", fid: "0123456789abcdee", sha256: sha(big), size: big.length }] });
  ok(typeof a?.ops?.[0]?.seq === "number", "an op naming held bytes is accepted");
  ok((await acctA.inspect({ sha256: sha(big) }))?.refs === 1, "and its entry holds a reference");
  // pins: a large patch's blob (CORR-D81-3)
  const P = "clientPINS";
  const docP = "0123456789cd";
  a = await s.ask(batch(docP, 1, [[1, pid(10, P), [], "big-patch", [sha(other)]]], { kind: "notebook" }));
  let i = await acctA.inspect({ sha256: sha(other) });
  ok(a?.batch?.seq === 1 && i?.refs === 1 && i.pins.length === 1 && i.pins[0].state === "held", "a patch's blob is pinned and held once the batch is accepted");
  a = await s.ask(batch(docP, 1, [[1, pid(10, P), [], "big-patch", [sha(other)]]]));
  ok((await acctA.inspect({ sha256: sha(other) }))?.refs === 1, "a resend doesn't pin twice");
  a = await s.ask(batch(docP, 1, [[2, pid(20, P), [pid(10, P)], "x", [sha(big)]]], { expect_head: { epoch: 1, seq: 0 } }));
  i = await acctA.inspect({ sha256: sha(big) });
  ok(a?.code === "conflict" && i?.refs === 1 && i.pins.length === 0, "a refused batch gives back the pins it made");
  a = await s.ask(batch(docP, 1, [[2, pid(20, P), [pid(10, P)], "x", ["e".repeat(64)]]]));
  ok(a?.code === "missing", "a patch naming a blob that isn't held is refused");
  // a lost answer: the batch committed, the answer never came (§4.3)
  a = await s.ask(batch(LOSE, 1, [[1, pid(30, P + "L"), [], "lost", [sha(big)]]], { kind: "board" }));
  i = await acctA.inspect({ sha256: sha(big) });
  ok(a?.code === "busy" && i?.pins.length === 1 && i.pins[0].state === "pending", "a lost answer leaves its pin pending");
  // (the account object's own alarm, set for when the forward lapses: real time, with the test's 300 ms pins)
  await until(async () => (await acctA.inspect({ sha256: sha(big) }))?.pins[0]?.state === "held");
  i = await acctA.inspect({ sha256: sha(big) });
  ok(i?.pins.length === 1 && i.pins[0].state === "held" && i.refs === 2, "once the forward can't commit any more, the alarm asks the document: it committed, so the pin is held");
  a = await s.ask(batch(LOSE, 1, [[1, pid(30, P + "L"), [], "lost", [sha(big)]]]));
  ok(a?.batch?.resent?.[pid(30, P + "L")] === 1 && (await acctA.inspect({ sha256: sha(big) }))?.refs === 2, "the client's resend is acknowledged with its seq, and pins nothing twice");
  // a delayed release from an old epoch can't remove a new pin with the same identity but its epoch (CORR-D81-3)
  a = await s.ask({ t: "clear", doc: docP, expect_head: { epoch: 1, seq: 1 }, root: { patches: [{ cseq: 1, id: pid(10, P), parents: [], size: 4, blobs: [sha(other)] }], body: Buffer.from("root").toString("base64") } });
  ok(a?.batch?.head?.epoch === 2, "clear, whose root uses the same client, cseq and blob as the old epoch's first patch");
  // (the new pin is made before the clear commits; the document's alarm then releases the old epoch's pins)
  await new Promise((r) => setTimeout(r, 500));
  i = await acctA.inspect({ sha256: sha(other) });
  ok(i?.pins.length === 1 && i.pins[0].epoch === 2 && i.pins[0].state === "held" && i.refs === 1, "the document's release of the old epoch, after the new pin with the same client, cseq and blob, removed only the old pin");
  await acctA.release({ doc: docP, pins: [{ epoch: 1, ref: `patch:${P}:1`, sha256: sha(other) }] });
  await acctA.release({ doc: docP, pins: [{ epoch: 1, ref: `patch:${P}:1`, sha256: sha(other) }] });
  i = await acctA.inspect({ sha256: sha(other) });
  ok(i?.pins.length === 1 && i.pins[0].epoch === 2 && i.refs === 1, "the old epoch's release, late and twice, removes only the old pin");
  s.ws.close();
}

// ---- daybreak2's slice-2 limits (LIMIT-7FB-1..3)
{
  // a dead upload on an otherwise idle account: its reservation ends, and its bytes come back, by the alarm alone
  const before = (await acctA.inspect({}))?.used;
  const r = await acctA.reserve({ account: A, sha256: "d".repeat(64), size: 1234 });
  ok(r?.ok?.id && (await acctA.inspect({}))?.used === before + 1234, "a reservation charges its bytes");
  await until(async () => (await acctA.inspect({}))?.used === before);
  ok((await acctA.inspect({}))?.used === before, "with nothing else happening, the reservation's end gives its bytes back (the alarm was armed at reserve)");
  // signed URLs: at most 600 a minute per account, counted at issue
  const sd = await signIn(D);
  const tiny = Buffer.from("t");
  await put(sd, tiny);
  let n = 0, last = 0;
  const t1 = Date.now();
  for (; n < 3000; n++) {
    last = (await fetchAt(SITE, `/api/sync/v1/blob/${sha(tiny)}`, { headers: { cookie: sd, "sec-fetch-site": "same-origin" } })).status;
    if (last !== 303) break;
  }
  // (600 at once, refilled at 10 a second while the loop runs)
  const refill = Math.ceil(((Date.now() - t1) / 1000) * 10) + 1;
  ok(last === 429 && n >= 600 && n <= 600 + refill, `urls_per_minute: 600 signed URLs at once, then 429 (${n} in ${Date.now() - t1} ms)`);
  // the files Worker: a per-IP limit before R2, and no signed read without one
  const bb = Buffer.from("a blob of B's for the files tests");
  await put(sb, bb);
  const loc = new URL((await fetchAt(SITE, `/api/sync/v1/blob/${sha(bb)}`, { headers: { cookie: sb, "sec-fetch-site": "same-origin" } })).headers.get("location") ?? "https://files.test/");
  ok(loc.pathname.startsWith("/p/s/"), "(a signed URL for the files tests)");
  await clearOfMinuteEdge();
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await mf.dispatchFetch(`https://tightfiles.test${loc.pathname}${loc.search}`, { headers: { "cf-connecting-ip": "198.51.100.7" } })).status);
  ok(codes[2] === 429, "a reused signed URL is limited per IP at the files Worker, before R2: " + codes.join());
  ok((await mf.dispatchFetch(`https://openfiles.test${loc.pathname}${loc.search}`)).status === 404, "without the per-IP limit bound, the files Worker serves no signed read");
  // a malformed plan from CoCalc is an outage: the last good limits stay
  fake.limits.set(B, { storage_bytes: 1 << 30, max_file_bytes: 50_000 });
  await new Promise((res) => setTimeout(res, 1200));
  let up = await put(sb, Buffer.from("b after a malformed plan"));
  ok(up.status === 201, "a plan without its sync part keeps the last good limits, never sync off");
  fake.limits.set(B, { storage_bytes: 1 << 30, max_file_bytes: 50_000, sync: { enabled: true, version_bytes: "lots", read_bytes_per_day: 1 } });
  await new Promise((res) => setTimeout(res, 1200));
  up = await put(sb, Buffer.from("b after a second malformed plan"));
  ok(up.status === 201, "nor does a malformed number");
  fake.limits.set(B, { storage_bytes: 1 << 30, max_file_bytes: 50_000, sync: { enabled: false, storage_bytes: 0, version_bytes: 0, read_bytes_per_day: 0 } });
  await new Promise((res) => setTimeout(res, 1200));
  up = await put(sb, Buffer.from("b after sync was turned off"));
  ok(up.status === 409, "a well-formed plan without sync does make the account read-only");
  fake.limits.set(B, sync(1 << 20, 1 << 20));
  await new Promise((res) => setTimeout(res, 1200));
}

// ---- astra's slice-2 findings (CORR-796-1..2)
{
  // a finalize answered again: the same answer for the same size, a conflict for another
  const r = await acctA.reserve({ account: A, sha256: sha(Buffer.from("fin")), size: 3 });
  ok(r?.ok?.id, "(a reservation)");
  const f1 = await acctA.finalize({ account: A, id: r.ok.id, size: 3 });
  const f2 = await acctA.finalize({ account: A, id: r.ok.id, size: 3 });
  const f3 = await acctA.finalize({ account: A, id: r.ok.id, size: 4 });
  ok(f1?.ok?.sha256 === sha(Buffer.from("fin")) && f2?.ok?.sha256 === f1.ok.sha256 && f3?.error?.code === "conflict", "finalize repeated gives its first answer; another size is a conflict (CORR-796-2)");
  // an outbox bigger than one alarm's 100: the alarm runs again until it is empty
  const n = await acctA.seed({ outbox: 250 });
  ok(n >= 250, "(250 keys in the outbox)");
  await until(async () => (await acctA.inspect({}))?.outbox === 0);
  ok((await acctA.inspect({}))?.outbox === 0, "an outbox of 250 is emptied by successive alarms (CORR-796-1)");
}

// ---- astra's slice-1 interleavings (CORR-321-1..3), with the test's gates in the document object
{
  const docNs = await mf.getDurableObjectNamespace("SYNC_DOC", "sync");
  const docOf = (doc) => docNs.get(docNs.idFromName(`doc:${hashOf(A)}:${doc}`));
  const s1 = await socket(sa);
  await hello(s1, dev1);
  const s2 = await socket(sa);
  await hello(s2, dev1);
  const H = Buffer.from("blob H for the interleavings");
  await put(sa, H);
  const refsH = async () => (await acctA.inspect({ sha256: sha(H) }))?.refs;
  // CORR-321-1: A (C, cseq 1, id 100) waits before the document; B (C, cseq 1, id 200) is accepted and its answer held; A is refused
  const docI = "1111aaaa2222";
  await s1.ask(batch(docI, 1, [[1, pid(1, "clientSEED"), [], "seed"]], { kind: "board" }));
  const C = "clientCCCC";
  const d = docOf(docI);
  await d.hold({ name: `before:${pid(100, C)}` });
  const aP = s1.ask(batch(docI, 1, [[1, pid(100, C), [], "A", [sha(H)]]]));
  await new Promise((r) => setTimeout(r, 60));
  await d.hold({ name: `after:${pid(200, C)}` });
  const bP = s2.ask(batch(docI, 1, [[1, pid(200, C), [], "B", [sha(H)]]]));
  await new Promise((r) => setTimeout(r, 60));
  await d.open({ name: `before:${pid(100, C)}` });
  const aR = await aP;
  ok(aR?.t === "error" && aR.code === "conflict", "A, whose cseq B took, is refused");
  await d.open({ name: `after:${pid(200, C)}` });
  const bR = await bP;
  const i1 = await acctA.inspect({ sha256: sha(H) });
  ok(bR?.batch?.new === 1 && i1?.refs === 1 && i1.pins.length === 1 && i1.pins[0].state === "held" && String(i1.pins[0].ref).endsWith(pid(200, C)), "B's patch keeps its pin, held: A's refusal took back only A's own (CORR-321-1)");
  // the same patch twice: A (stale expect_head) waits, B commits and its answer waits, then A is answered
  const docJ = "1111aaaa3333";
  await s1.ask(batch(docJ, 1, [[1, pid(1, "clientSEEE"), [], "seed"]], { kind: "board" }));
  const dj = docOf(docJ);
  const X = "clientXSAM";
  await dj.hold({ name: `before:${pid(50, X)}` });
  const aP2 = s1.ask(batch(docJ, 1, [[1, pid(50, X), [], "same", [sha(H)]]], { expect_head: { epoch: 1, seq: 0 } }));
  await new Promise((r) => setTimeout(r, 60));
  await dj.hold({ name: `after:${pid(50, X)}` });
  const bP2 = s2.ask(batch(docJ, 1, [[1, pid(50, X), [], "same", [sha(H)]]]));
  await new Promise((r) => setTimeout(r, 60));
  await dj.open({ name: `before:${pid(50, X)}` });
  const aR2 = await aP2;
  let i2 = await acctA.inspect({ sha256: sha(H) });
  ok(aR2?.t === "ack" && aR2.batch.new === 0 && i2.pins.filter((p) => String(p.ref).endsWith(pid(50, X)))[0]?.state === "pending", "the same patch: A is answered as a resend, and the pin stays pending while B's attempt is in flight");
  await dj.open({ name: `after:${pid(50, X)}` });
  await bP2;
  i2 = await acctA.inspect({ sha256: sha(H) });
  ok(i2.refs === 2 && i2.pins.filter((p) => String(p.ref).endsWith(pid(50, X)))[0]?.state === "held", "and is held, once, when B answers");
  // CORR-321-2: seq 2's answer arrives after seq 3's; a lost answer, then a resend
  const docK = "1111aaaa4444";
  const K = "clientKKKK";
  await s1.ask(batch(docK, 1, [[1, pid(1, K), [], "one"]], { kind: "board" }));
  const dk = docOf(docK);
  await dk.hold({ name: `after:${pid(2, K)}` });
  const two = s1.ask(batch(docK, 1, [[2, pid(2, K), [pid(1, K)], "two"]]));
  await new Promise((r) => setTimeout(r, 200));
  const three = await s2.ask(batch(docK, 1, [[3, pid(3, K), [pid(2, K)], "three"]]));
  ok(three?.batch?.seq === 3, "seq 3 is answered first");
  await dk.open({ name: `after:${pid(2, K)}` });
  await two;
  let ik = await acctA.inspect({ doc: docK });
  ok(Number(ik?.doc?.head_seq) === 3 && Number(ik.doc.bytes) === 11, "seq 2's late answer doesn't move the account's head back, and the bytes are the document's own total (CORR-321-2)");
  const lostDoc = LOSE;
  const before = Number((await acctA.inspect({ doc: lostDoc }))?.doc?.bytes);
  const L = "clientLOS2";
  const lr = await s1.ask(batch(lostDoc, 1, [[1, pid(40, L), [], "lostbytes"]]));
  ok(lr?.code === "busy", "an answer lost after the commit");
  const again = await s1.ask(batch(lostDoc, 1, [[1, pid(40, L), [], "lostbytes"]]));
  ik = await acctA.inspect({ doc: lostDoc });
  ok(again?.batch?.new === 0 && Number(ik?.doc?.bytes) === before + 9, "the resend's answer carries the document's total, so the account's bytes include the lost commit");
  // CORR-321-3: on an account with nothing else pending, the alarm is armed by the pin itself, and
  // again by the constructor after a crash that lost it
  {
    const se = await signIn(E);
    await post(se, "/api/sync/v1/enable", {});
    const acctE = () => acctNs.get(acctNs.idFromName("acct:" + hashOf(E)));
    const HE = Buffer.from("E's blob");
    await put(se, HE);
    await new Promise((r) => setTimeout(r, 6000)); // (finalize's own wake passes, so only a pin can arm the alarm)
    const se1 = await socket(se);
    await hello(se1, "device-e-000001");
    const docM = "1111aaaa5555";
    await se1.ask(batch(docM, 1, [[1, pid(1, "clientMSED"), [], "seed"]], { kind: "board" }));
    const dm = docNs.get(docNs.idFromName(`doc:${hashOf(E)}:${docM}`));
    const M = "clientMMMM";
    await dm.hold({ name: `after:${pid(60, M)}` });
    // (a lapse longer than a restart and its poll take under load, so the pin is still pending when
    // the restarted object is inspected: 1 s didn't always outlast them in a crowded CI run)
    const LAPSE = 10_000;
    await acctE().testPinMs({ ms: LAPSE });
    const quiet = await acctE().inspect({});
    ok(quiet?.alarm === null || quiet.alarm > Date.now() + 3600_000, "(account E has no alarm soon before the pin: only the unused holding's, a day away)");
    const t0 = Date.now();
    se1.send({ ...batch(docM, 1, [[1, pid(60, M), [], "crash", [sha(HE)]]]), req: 9999 });
    await new Promise((r) => setTimeout(r, 60));
    const ia = await acctE().inspect({ sha256: sha(HE) });
    ok(ia?.alarm !== null && ia.alarm >= t0 + LAPSE && ia.alarm <= t0 + LAPSE + 200, "the pending pin arms the alarm for its lapse, before the forward answers");
    await acctE().crash().catch(() => {});
    // (the restarted object, with the document still holding the answer: polled until it answers, since a
    // restart under load takes longer than any fixed wait)
    let ib = null;
    await until(async () => (ib = await acctE().inspect({ sha256: sha(HE) }).catch(() => null)) !== null, 8_000);
    ok(Date.now() < t0 + LAPSE, "(the restarted object answered before the pin lapsed: " + (Date.now() - t0) + " ms of " + LAPSE + ")");
    ok(ib?.alarm !== null && ib?.alarm !== undefined && ib.alarm < Date.now() + 3600_000 && ib.pins.length === 1 && ib.pins[0].state === "pending", "after a crash that lost the alarm, the restarted object arms it again for the pending pin: " + JSON.stringify({ alarm: ib?.alarm, pins: ib?.pins?.map((p) => p.state) }));
    await dm.open({ name: `after:${pid(60, M)}` });
    await until(async () => (await acctE().inspect({ sha256: sha(HE) }).catch(() => null))?.pins[0]?.state === "held", 30_000);
    const ic = await acctE().inspect({ sha256: sha(HE) });
    ok(ic?.pins[0]?.state === "held" && ic.refs === 1, "and the alarm decides it from the document: committed, so held (CORR-321-3)");
  }
  // CORR-796-1: an alarm earlier than a pending pin's lapse arms the next one for that lapse
  // (a new socket: the crash above closed the old ones)
  const s3 = await socket(sa);
  await hello(s3, dev1);
  // (a lost answer, so only the alarm can decide the pin; and an alarm forced before its lapse)
  const N = "clientNNNN";
  const lostN = await s3.ask(batch(LOSE, 1, [[1, pid(70, N), [], "early", [sha(H)]]]));
  ok(lostN?.code === "busy", "(the answer is lost)");
  await acctA.seed({ alarmNow: true });
  await new Promise((r) => setTimeout(r, 100));
  ok((await acctA.inspect({ sha256: sha(H) }))?.pins.filter((p) => String(p.ref).endsWith(pid(70, N)))[0]?.state === "pending", "(the early alarm, before the lapse, leaves it pending)");
  await until(async () => (await acctA.inspect({ sha256: sha(H) }))?.pins.find((p) => String(p.ref).endsWith(pid(70, N)))?.state === "held");
  const ie = await acctA.inspect({ sha256: sha(H) });
  ok(ie?.pins.filter((p) => String(p.ref).endsWith(pid(70, N)))[0]?.state === "held", "an alarm that fires before a pin's lapse leaves the next armed: the pin is decided");
  s3.ws.close();
  s1.ws.close();
  s2.ws.close();
}

// ---- astra's b8a77721 residuals (CORR-B8A-1..2)
{
  const docNs = await mf.getDurableObjectNamespace("SYNC_DOC", "sync");
  const docOf = (doc) => docNs.get(docNs.idFromName(`doc:${hashOf(A)}:${doc}`));
  const q1 = await socket(sa);
  await hello(q1, dev1);
  const q2 = await socket(sa);
  await hello(q2, dev1);
  const H = Buffer.from("blob H for the interleavings");
  // CORR-B8A-1: A's lookup (no) is asked for before B's attempt begins, and answered after B's (yes)
  const docQ = "3333cccc4444";
  await q1.ask(batch(docQ, 1, [[1, pid(1, "clientQSED"), [], "seed"]], { kind: "board" }));
  const dq = docOf(docQ);
  const P = pid(80, "clientQQQQ");
  await dq.hold({ name: `accepted:${P}#1` });
  await dq.hold({ name: `accepted:${P}#2` });
  const refs0 = (await acctA.inspect({ sha256: sha(H) }))?.refs;
  const aP = q1.ask(batch(docQ, 1, [[1, P, [], "P", [sha(H)]]], { expect_head: { epoch: 1, seq: 0 } }));
  await new Promise((r) => setTimeout(r, 60));
  const bP = q2.ask(batch(docQ, 1, [[1, P, [], "P", [sha(H)]]]));
  await new Promise((r) => setTimeout(r, 60));
  await dq.open({ name: `accepted:${P}#1` });
  const aR = await aP;
  await dq.open({ name: `accepted:${P}#2` });
  const bR = await bP;
  const iq = await acctA.inspect({ sha256: sha(H) });
  const pinP = iq?.pins.find((p) => String(p.ref).endsWith(P));
  ok(aR?.code === "conflict" && bR?.batch?.new === 1 && pinP?.state === "held" && iq.refs === refs0 + 1, "a lookup asked for before a later attempt began never decides the pin: B's patch keeps it (CORR-B8A-1)");
  // CORR-6D6-1: a pin dropped and made again gets a new generation, so A's stale answer can't name it
  const docR = "3333cccc5555";
  await q1.ask(batch(docR, 1, [[1, pid(1, "clientRSED"), [], "seed"]], { kind: "board" }));
  const dr = docOf(docR);
  const P2 = pid(81, "clientRRRR");
  await dr.hold({ name: `accepted:${P2}#1` });
  await dr.hold({ name: `accepted:${P2}#3` });
  const refs1 = (await acctA.inspect({ sha256: sha(H) }))?.refs;
  const aP3 = q1.ask(batch(docR, 1, [[1, P2, [], "P", [sha(H)]]], { expect_head: { epoch: 1, seq: 0 } }));
  await new Promise((r) => setTimeout(r, 60));
  const cR = await q2.ask(batch(docR, 1, [[1, P2, [], "P", [sha(H)]]], { expect_head: { epoch: 1, seq: 0 } }));
  ok(cR?.code === "conflict" && !(await acctA.inspect({ sha256: sha(H) }))?.pins.some((p) => String(p.ref).endsWith(P2)), "(C is refused too, and its own answer drops the pin)");
  // (B's answer, "yes", is held too, and A's stale "no" is given first: astra's order)
  const bP3 = q2.ask(batch(docR, 1, [[1, P2, [], "P", [sha(H)]]]));
  await new Promise((r) => setTimeout(r, 60));
  await dr.open({ name: `accepted:${P2}#1` });
  await aP3;
  await dr.open({ name: `accepted:${P2}#3` });
  const bR3 = await bP3;
  const ir = await acctA.inspect({ sha256: sha(H) });
  ok(bR3?.batch?.new === 1 && ir?.pins.find((p) => String(p.ref).endsWith(P2))?.state === "held" && ir.refs === refs1 + 1, "a pin dropped and made again has a new generation: A's stale answer doesn't take B's (CORR-6D6-1)");
  // CORR-B8A-2: the document unavailable for a while: the pin's lookups back off, and the alarm doesn't loop
  const L = "clientOUTG";
  const dl = docOf(LOSE);
  const lost = await q1.ask(batch(LOSE, 1, [[1, pid(90, L), [], "outage", [sha(H)]]]));
  ok(lost?.code === "busy", "(an answer lost, so only the alarm decides this pin)");
  await dl.setFailAccepted({ on: true });
  const a0 = (await acctA.inspect({}))?.alarms;
  await new Promise((r) => setTimeout(r, 3500));
  const io = await acctA.inspect({ sha256: sha(H) });
  const pinL = io?.pins.find((p) => String(p.ref).endsWith(pid(90, L)));
  ok(pinL?.state === "pending" && Number(pinL.tries) >= 2 && io.alarms - a0 <= 8, `an outage of 3.5 s: the lookups back off (tries ${pinL?.tries}, alarms ${io?.alarms - a0}), never a loop (CORR-B8A-2)`);
  await dl.setFailAccepted({ on: false });
  let held = false;
  for (let w = 0; w < 30 && !held; w++) {
    await new Promise((r) => setTimeout(r, 250));
    held = (await acctA.inspect({ sha256: sha(H) }))?.pins.find((p) => String(p.ref).endsWith(pid(90, L)))?.state === "held";
  }
  ok(held, "and once the document answers, the pin is decided: committed, so held");
  q1.ws.close();
  q2.ws.close();
}

// ---- document sockets: single-use tickets, fences, leases, live batches (§2, §5.1)
{
  const docS = "2222bbbb3333";
  const docPath = (t) => `/api/sync/v1/doc/${hashOf(A)}/${docS}?ticket=${t}`;
  const a1 = await socket(sa);
  await hello(a1, dev1);
  await a1.ask(batch(docS, 1, [[1, pid(1, "clientDS01"), [], "seed"]], { kind: "board" }));
  let t = await a1.ask({ t: "ticket", doc: docS });
  ok(t?.t === "ticket" && /^[0-9a-f]{32}$/.test(t.ticket), "a ticket for a document socket");
  const d1 = await socket(sa, SITE, docPath(t.ticket));
  ok(d1.status === 101, "the document socket opens with it");
  ok((await socket(sa, SITE, docPath(t.ticket))).status === 403, "a ticket is used once: a replay is refused");
  ok((await socket(await signIn(A), SITE, docPath((await a1.ask({ t: "ticket", doc: docS })).ticket))).status === 403, "another session of the same account can't use this session's ticket");
  ok((await socket(sb, SITE, `/api/sync/v1/doc/${hashOf(A)}/${docS}?ticket=${(await a1.ask({ t: "ticket", doc: docS })).ticket}`)).status === 404, "another account can't reach A's document socket");
  const a2 = await socket(sa);
  await hello(a2, dev2);
  const t2 = await a2.ask({ t: "ticket", doc: docS });
  const d2 = await socket(sa, SITE, docPath(t2.ticket));
  ok(d2.status === 101 && (await d2.next((m) => m.t === "watching"))?.n === 2, "a second device's document socket: both hear `watching`, 2");
  // live batches and presence
  const live = d2.next((m) => m.t === "batches");
  const changed = a2.next((m) => m.t === "changed" && m.doc === docS);
  let r = await d1.ask(batch(docS, 1, [[1, pid(10, "clientDS02"), [pid(1, "clientDS01")], "live"]]));
  const lb = await live;
  ok(r?.batch?.seq === 2 && lb?.items?.[0]?.seq === 2 && payloads(lb.items[0])[0] === "live", "a batch over a document socket reaches the other at once");
  ok((await changed)?.head?.seq === 2, "and the account's other sockets hear `changed`");
  ok(Number((await acctA.inspect({ doc: docS }))?.doc?.head_seq) === 2, "the account object records the head itself: a document socket's batch is decided through it (CORR-6D6-3)");
  r = await d1.ask(batch(docS, 1, [[2, pid(20, "clientDS02"), [pid(10, "clientDS02")], "x", [sha(big)]]]));
  ok(r?.batch?.new === 1 && (await acctA.inspect({ sha256: sha(big) }))?.pins.some((p) => String(p.ref).endsWith(pid(20, "clientDS02")) && p.state === "held"), "a batch with blobs over a document socket is pinned by the account object too");
  const pres = d2.next((m) => m.t === "presence");
  d1.send({ t: "presence", state: { cursor: [1, 2] } });
  ok((await pres)?.state?.cursor?.[1] === 2, "presence is relayed, never stored");
  d1.send({ t: "presence", state: { big: "é".repeat(2100) } });
  ok((await d1.next((m) => m.t === "error"))?.code === "limit", "presence is small, in UTF-8 bytes: 2,100 two-byte characters are over 4,096 (LIMIT-6D6-2)");
  // coalesced: 40 at once reach a peer as at most a few, the last one last
  await new Promise((res) => setTimeout(res, 200));
  d2.queue.length = 0;
  for (let i = 0; i < 40; i++) d1.send({ t: "presence", state: { i } });
  await new Promise((res) => setTimeout(res, 500));
  const seen = d2.queue.filter((m) => m.t === "presence");
  ok(seen.length >= 1 && seen.length <= 8 && seen[seen.length - 1].state.i === 39, `presence is coalesced per socket, the latest kept (${seen.length} of 40 relayed)`);
  // the batch rate holds on a document socket too (LIMIT-6D6-1)
  const rates = [];
  for (let i = 0; i < 30; i++) rates.push((await d1.ask(batch(docS, 1, [[3 + i, pid(100 + i, "clientDS02"), [pid(i === 0 ? 20 : 99 + i, "clientDS02")], "r"]])))?.code ?? "ok");
  ok(rates.includes("rate"), "batches over a document socket count against the account's batch rate");
  // the per-message fence: a fenced session's socket that wasn't closed (a test seam) can't write
  const docNsF = await mf.getDurableObjectNamespace("SYNC_DOC", "sync");
  const sessA = createHash("sha256").update(decodeURIComponent(sa.split("=")[1])).digest("hex");
  await new Promise((res) => setTimeout(res, 1100));
  await docNsF.get(docNsF.idFromName(`doc:${hashOf(A)}:${docS}`)).fenceSession({ session: sessA, expires: Date.now() + 3600_000, keepOpen: true });
  // (a valid batch, a new client's first patch: only the fence can refuse it)
  const fenced = await d1.ask(batch(docS, 1, [[1, pid(500, "clientDSF1"), [], "fenced"]]));
  ok(fenced === null && d1.queue.some((m) => m.t === "revoked"), "a socket whose session is fenced, though still open, can't write: the check on every message refuses it");
  // astra's race (CORR-D81-7): a redemption answered only after the session is revoked doesn't attach
  const s9 = await signIn(A);
  const a9 = await socket(s9);
  await hello(a9, "device-race-0001");
  const t9 = await a9.ask({ t: "ticket", doc: docS });
  await acctA.holdRedeem({});
  const pending = socket(s9, SITE, docPath(t9.ticket));
  await new Promise((res) => setTimeout(res, 150));
  await fetchAt(SITE, "/auth/logout", { method: "POST", headers: { cookie: s9, origin: SITE } });
  await new Promise((res) => setTimeout(res, 150));
  await acctA.holdRedeem({ release: true });
  const late = await pending;
  ok(late.status === 403, "a ticket redeemed before the revoke, whose socket would attach after it, is refused at the attach");
  ok(a9.closed === 4401, "signing out closed the session's account socket");
  // a fence after the attach closes the socket
  const s8 = await signIn(A);
  const a8 = await socket(s8);
  await hello(a8, "device-race-0002");
  const d8 = await socket(s8, SITE, docPath((await a8.ask({ t: "ticket", doc: docS })).ticket));
  ok(d8.status === 101, "(another session's document socket)");
  await fetchAt(SITE, "/auth/logout", { method: "POST", headers: { cookie: s8, origin: SITE } });
  await new Promise((res) => setTimeout(res, 300));
  await new Promise((res) => setTimeout(res, 300));
  ok(d8.queue.some((m) => m.t === "revoked"), "signing out tells the session's document sockets: revoked");
  d8.queue.length = 0;
  const after = await d8.ask(batch(docS, 1, [[1, pid(30, "clientDS08"), [pid(10, "clientDS02")], "after"]])).catch(() => null);
  ok(!after || after.t !== "ack", "and they can't write after it");
  ok((await socket(s8)).status === 401, "and the session is gone");
  // a revoke recorded whose fences haven't arrived yet: the document socket still can't write, since its
  // batches are decided by the account object, which knows (CORR-6D6-2)
  const s4 = await signIn(A);
  const a4 = await socket(s4);
  await hello(a4, "device-nofence-1");
  const d4 = await socket(s4, SITE, docPath((await a4.ask({ t: "ticket", doc: docS })).ticket));
  const sess4 = createHash("sha256").update(decodeURIComponent(s4.split("=")[1])).digest("hex");
  await acctA.revoke({ session: sess4, expires: Date.now() + 3600_000, testNoFence: true });
  const w4 = await d4.ask(batch(docS, 1, [[1, pid(600, "clientDSN1"), [], "unfenced"]]));
  ok(w4?.t === "error" && w4.code === "forbidden", "a revoked session's document socket, not yet fenced, can't write");
  d4.ws.close();
  // sign-out fails, keeping the session, if the revoke can't be recorded (CORR-6D6-2)
  const s6 = await signIn(A);
  const a6 = await socket(s6);
  await hello(a6, "device-fail-0001");
  await acctA.setFailRevoke({ on: true });
  const lo = await fetchAt(SITE, "/auth/logout", { method: "POST", headers: { cookie: s6, origin: SITE } });
  await acctA.setFailRevoke({ on: false });
  ok(lo.status === 503 && (await socket(s6)).status === 101, "a sign-out whose revoke fails says so, and keeps the session");
  // a revoke with many documents: the first 100 fences now, the rest from the alarm (LIMIT-6D6-4)
  const sess6 = createHash("sha256").update(decodeURIComponent(s6.split("=")[1])).digest("hex");
  await acctA.seedTicketDocs({ session: sess6, n: 250 });
  const lo2 = await fetchAt(SITE, "/auth/logout", { method: "POST", headers: { cookie: s6, origin: SITE } });
  // (250 made up, 100 sent at once; and the unfenced session above has one more due)
  const due0 = (await acctA.inspect({}))?.fences_due;
  ok(lo2.status === 200 && due0 >= 100 && due0 <= 151, `a revoke fences 100 documents at once and leaves the rest to the alarm (${due0} due)`);
  for (let w = 0; w < 40 && (await acctA.inspect({}))?.fences_due > 0; w++) await new Promise((res) => setTimeout(res, 250));
  ok((await acctA.inspect({}))?.fences_due === 0, "and the alarm sends the rest, a page at a time");
  // tickets are issued at a rate, used or not (LIMIT-6D6-3)
  const s5 = await signIn(A);
  const a5 = await socket(s5);
  await hello(a5, "device-tick-0001");
  const sess5 = createHash("sha256").update(decodeURIComponent(s5.split("=")[1])).digest("hex");
  let issued = 0, why = null;
  for (let i = 0; i < 80 && !why; i++) {
    const tk = await a5.ask({ t: "ticket", doc: docS });
    if (tk?.t !== "ticket") why = tk?.code;
    else {
      issued++;
      // (a socket that opens and closes at once: the ticket used, its lease given back)
      const rd = await acctA.redeem({ nonce: tk.ticket, doc: docS, account: A, session: sess5 });
      if (rd?.ok) await acctA.lease({ socket: rd.ok.socket, release: true });
    }
  }
  ok(why === "rate" && issued >= 60 && issued <= 66, `sockets opened and closed at once still meet the ticket rate: ${issued}, then ${why}`);
  a5.ws.close();
  // leases: at most 16 sockets per session; a lost close frees its slot when the lease ends (1 s in this test)
  const s7 = await signIn(A);
  const a7 = await socket(s7);
  await hello(a7, "device-lease-001");
  const docNs7 = await mf.getDurableObjectNamespace("SYNC_DOC", "sync");
  let got = 0, refusedAt = null;
  const sess7 = createHash("sha256").update(decodeURIComponent(s7.split("=")[1])).digest("hex");
  for (let i = 0; i < 17; i++) {
    const tk = (await a7.ask({ t: "ticket", doc: docS })).ticket;
    // (redeemed straight from the account object, as the document's upgrade would, with no socket to close)
    const rd = await acctA.redeem({ nonce: tk, doc: docS, account: A, session: sess7 });
    if (rd?.ok) got++;
    else refusedAt ??= rd?.error?.code;
  }
  ok(got === 16 && refusedAt === "busy", `16 document sockets per session, then busy (${got}, ${refusedAt})`);
  await new Promise((res) => setTimeout(res, 1200));
  const rd = await acctA.redeem({ nonce: (await a7.ask({ t: "ticket", doc: docS })).ticket, doc: docS, account: A, session: sess7 });
  ok(rd?.ok?.socket, "leases whose close was never reported end by themselves, and free their slots");
  for (const x of [a1, a2, d1, d2, a7, a8]) x.ws?.close();
}

// ---- the access list, behind the owner-qualified name (§2): a document object refuses an account not on it
{
  const ns = await mf.getDurableObjectNamespace("SYNC_DOC", "sync");
  const { createHash } = await import("node:crypto");
  const hashA = createHash("sha256").update("sagebrush-account\n" + A).digest("hex");
  const doc = ns.get(ns.idFromName(`doc:${hashA}:${docA}`));
  const r = await doc.pull({ account: B, epoch: 2, after: 0 });
  ok(r?.error?.code === "unknown_doc", "the document object itself refuses an account not on its access list, as if it didn't exist");
  const w = await doc.batch({ account: B, writer: "session:x", author: "person", device: "x", pin_expires: Date.now() + 60_000, batch: { doc: docA, epoch: 2, patches: [{ cseq: 1, id: pid(5000, "clientEVIL"), parents: [], size: 1 }], body: new Uint8Array([1]) } });
  ok(w?.error?.code === "unknown_doc", "and its writes");
  const own = await doc.pull({ account: A, epoch: 2, after: 0 });
  ok(own?.ok?.items?.length === 2, "while its owner reads it");
  const late = await doc.batch({ account: A, writer: "session:" + dev1, author: "person", device: dev1, pin_expires: Date.now() - 1, batch: { doc: docA, epoch: 2, patches: [{ cseq: 1, id: pid(5000, "clientLATE"), parents: [], size: 1 }], body: new Uint8Array([1]) } });
  ok(late?.error?.code === "busy", "a forward past its pin_expires is refused (§4.3)");
}

// ---- CoCalc's signed plan notice (§6)
const signedPost = (key, path, body, ts = Math.floor(Date.now() / 1000)) => fetchAt(SITE, path, {
  method: "POST",
  headers: { "content-type": "application/json", "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": "sha256=" + createHmac("sha256", key).update(`${ts}\nPOST\n${path}\n${body}`).digest("hex") },
  body,
});
const signedGet = (key, path, ts = Math.floor(Date.now() / 1000)) => fetchAt(SITE, path, { headers: { "x-sagebrush-timestamp": String(ts), "x-sagebrush-signature": "sha256=" + createHmac("sha256", key).update(`${ts}\nGET\n${path}\n`).digest("hex") } });
{
  const tiny = { storage_bytes: 5, max_file_bytes: 50_000, sync: { enabled: true, version_bytes: 0, read_bytes_per_day: 0 } };
  const body = (issued, limits = tiny, account_id = D) => JSON.stringify({ request_id: crypto.randomUUID(), account_id, issued, limits });
  let r = await fetchAt(SITE, "/api/admin/limits", { method: "POST", headers: { "content-type": "application/json" }, body: body(100) });
  ok(r.status === 401, "a plan notice that isn't signed is refused");
  r = await signedPost(PURGE_KEY, "/api/admin/limits", body(100));
  ok(r.status === 401, "nor one signed with the purge key: the notice has its own key");
  r = await signedPost(LIMITS_KEY, "/api/admin/limits", body(100), Math.floor(Date.now() / 1000) - 600);
  ok(r.status === 401, "nor one older than 5 minutes");
  const issued = Date.now();
  r = await signedPost(LIMITS_KEY, "/api/admin/limits", body(issued));
  ok(r.status === 200 && (await r.json()).applied === true, "a signed notice is applied");
  const sd = await signIn(D);
  ok((await put(sd, Buffer.from("over the new limit"))).status === 507, "at once: the new, smaller limit holds");
  r = await signedPost(LIMITS_KEY, "/api/admin/limits", body(issued - 1, sync(1 << 20, 1 << 20)));
  ok(r.status === 200 && (await r.json()).applied === false, "an older notice, arriving late, is not applied");
  r = await signedPost(LIMITS_KEY, "/api/admin/limits", body(issued + 1, { storage_bytes: 1 }));
  ok(r.status === 400, "a malformed one is refused");
  r = await signedPost(LIMITS_KEY, "/api/admin/limits", body(issued + 1, tiny, C));
  ok(r.status === 200 && (await r.json()).applied === false, "for an account that never turned sync on, nothing is made");
}

// ---- the admin routes' bounds, before any body or signature work (LIMIT-5E2-1)
{
  const huge = "x".repeat(5000);
  let r = await fetchAt(SITE, "/api/admin/limits", { method: "POST", headers: { "content-type": "application/json", "content-length": String(huge.length) }, body: huge });
  ok(r.status === 413, "an oversized notice is refused by its Content-Length, before it is read");
  // (a body with no Content-Length: a stream)
  const stream = () => new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode(huge)); c.close(); } });
  r = await fetchAt(SITE, "/api/admin/limits", { method: "POST", headers: { "content-type": "application/json" }, body: stream(), duplex: "half" });
  ok(r.status === 411, "a notice with no Content-Length is refused before it is read (" + r.status + ")");
  r = await fetchAt(SITE, "/api/admin/purge", { method: "POST", headers: { "content-type": "application/json", "content-length": String(huge.length) }, body: huge });
  ok(r.status === 413, "so is an oversized purge, before sync or sharing read it");
  // (share-purge-411: sync's gate answers as sharing's adminLength does, for both its admin POSTs; the lengths a
  // client can actually send: none (a stream), 0 (no body), 4096, 4097, 5000. Those the runtime refuses or rewrites
  // before the Worker ("+10", "0x10", ...) are adminLength's own cases, in web/share/test-share.mjs)
  // (adminLength's answers for these, as CLEARed at core 2f058642; that the gate calls it is checked below)
  const sent = [["none", () => ({ body: stream(), duplex: "half" }), 411], ["0", () => ({ body: "" }), 411], ["4096", () => ({ body: "x".repeat(4096) }), null],
    ["4097", () => ({ body: "x".repeat(4097) }), 413], ["5000", () => ({ body: huge }), 413]];
  const got = [];
  for (const route of ["/api/admin/limits", "/api/admin/purge"])
    for (const [name, init, want] of sent) {
      const s = (await fetchAt(SITE, route, { method: "POST", headers: { "content-type": "application/json" }, ...init() })).status;
      // (null: past the gate, so refused by its signature instead)
      got.push({ route, name, s, want, same: want === null ? s === 401 : s === want });
    }
  ok(got.every((g) => g.same), "share-purge-411: both admin POSTs answer as sharing's adminLength: none and 0 are 411, 4096 passes the gate (401, its signature), 4097 and 5000 are 413: " + JSON.stringify(got.filter((g) => !g.same)));
  const src = readFileSync(join(here, "server.ts"), "utf8");
  const gateSrc = src.slice(src.indexOf("async function adminGate("), src.indexOf("\n}\n", src.indexOf("async function adminGate(")));
  ok(/import \{[^}]*\badminLength\b[^}]*\} from "\.\.\/share\/server\.ts"/.test(src) && gateSrc.includes("adminLength(req.headers.get(\"content-length\"))") && !/content-length[^\n]*\/\^/.test(gateSrc),
    "share-purge-411: adminGate judges the length with sharing's adminLength, imported, and keeps no check of its own");
  await clearOfMinuteEdge();
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await fetchAt("https://tight.test", "/api/admin/limits", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.5" }, body: "{}" })).status);
  ok(codes.join() === "401,401,429,429", "the admin routes have a per-IP limit before any signature check: " + codes.join());
  const pc = [];
  for (let i = 0; i < 3; i++) pc.push((await fetchAt("https://tight.test", "/api/admin/purge", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.7" }, body: '{"account_id":"x","request_id":"00000000-0000-4000-8000-000000000000"}' })).status);
  ok(pc[2] === 429, "and the purge route, before sync or sharing read the body: " + pc.join());
  const gc = [];
  for (let i = 0; i < 3; i++) gc.push((await mf.dispatchFetch("https://tight.test/api/admin/sync-purge/00000000-0000-4000-8000-000000000000", { headers: { "cf-connecting-ip": "192.0.2.6" } })).status);
  ok(gc[2] === 429, "and the purge status too: " + gc.join());
  r = await mf.dispatchFetch("https://nolimit.test/api/admin/limits", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(r.status === 404, "without the admin limit bound, sync's admin routes are off");
}

// ---- deleting (§7, §9): "Delete my synced data", and CoCalc's purge
{
  const bucket = await mf.getR2Bucket("SHARE_BUCKET", "sync");
  const listed = async (prefix) => (await bucket.list({ prefix })).objects.length;
  const sP = (id) => `s/${hashOf(id).slice(0, 32)}/`;
  // A shares a file too: sharing's data must survive the deletion of synced data
  const shared = Buffer.from("A's shared file");
  const up = await fetchAt(SITE, `/api/share/blob/${sha(shared)}`, { method: "PUT", headers: { cookie: sa, origin: SITE, "content-type": "application/octet-stream" }, body: shared });
  ok(up.status === 201 || up.status === 200, "(A uploads a file to share)");
  const aShared = await listed(`a/${hashOf(A).slice(0, 32)}/`);
  ok((await listed(sP(A))) > 0 && aShared > 0, "(A has synced and shared bytes in R2)");
  const s = await socket(sa);
  await hello(s, dev1);
  let r = await post(sa, "/api/sync/v1/delete", { confirm: "yes", generation: 1 });
  ok(r.status === 400, "deleting synced data needs {confirm: \"delete\"}");
  ok((await post(sa, "/api/sync/v1/delete", { confirm: "delete" })).status === 400, "and the generation it deletes");
  const acctA2 = acctNs.get(acctNs.idFromName("acct:" + hashOf(A)));
  await acctA2.holdPurge({ on: true });
  r = await del(sa, A);
  ok(r.status === 202, "Delete my synced data");
  for (let w = 0; w < 40 && s.closed === null; w++) await new Promise((res) => setTimeout(res, 50));
  ok(s.closed === 4410, "the account's sockets close at once");
  ok((await post(sa, "/api/sync/v1/enable", {})).status === 409, "turning sync on again waits for the deletion");
  await acctA2.holdPurge({ on: false });
  let state = null;
  for (let w = 0; w < 60 && state !== "purged"; w++) {
    await new Promise((res) => setTimeout(res, 250));
    state = (await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(A)).first())?.state;
  }
  ok(state === "purged", "the deletion finishes, from the account object's alarm");
  ok((await listed(sP(A))) === 0, "no synced byte of A's is left in R2");
  ok((await listed(`a/${hashOf(A).slice(0, 32)}/`)) === aShared, "and sharing's bytes are untouched");
  const docNs = await mf.getDurableObjectNamespace("SYNC_DOC", "sync");
  const gone = await docNs.get(docNs.idFromName(`doc:${hashOf(A)}:${docA}`)).pull({ account: A, epoch: 2, after: 0 });
  ok(gone?.error?.code === "unknown_doc", "A's documents are gone");
  ok((await acctNs.get(acctNs.idFromName("acct:" + hashOf(A))).inspect({})) === null, "and the account object holds nothing");
  const rec = await db.prepare("SELECT * FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(A)).first();
  ok(rec && !JSON.stringify(rec).includes(A) && rec.kind === "self", "the record keeps counts and no account id");
  r = await post(sa, "/api/sync/v1/enable", {});
  ok(r.status === 200, "afterwards, sync can be turned on again");
  const s2 = await socket(sa);
  const h2 = await hello(s2, dev1);
  ok(h2.welcome?.next_dseq === 1 && h2.index?.ops?.length === 0 && h2.welcome.generation === 2, "and starts empty, as generation 2");
  s2.ws.close();
  // CoCalc's purge of a deleted account: sharing's and sync's parts
  const rid = crypto.randomUUID();
  const pb = JSON.stringify({ account_id: B, request_id: rid });
  r = await signedPost(PURGE_KEY, "/api/admin/purge", pb);
  ok(r.status === 202, "CoCalc's signed purge is accepted (sharing's part answers)");
  state = null;
  for (let w = 0; w < 60 && state !== "purged"; w++) {
    await new Promise((res) => setTimeout(res, 250));
    state = (await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(B)).first())?.state;
  }
  ok(state === "purged" && (await listed(sP(B))) === 0, "and sync's part deletes B's synced data");
  const st = await signedGet(PURGE_KEY, `/api/admin/sync-purge/${rid}`);
  ok(st.status === 200 && (await st.json()).state === "purged", "its status, signed, by the request id");
  ok((await signedGet(LIMITS_KEY, `/api/admin/sync-purge/${rid}`)).status === 401, "the status needs the purge key");
}

// ---- astra's slice-4 findings (CORR-5E2-1..3)
{
  const bucket = await mf.getR2Bucket("SHARE_BUCKET", "sync");
  const docNs = await mf.getDurableObjectNamespace("SYNC_DOC", "sync");
  // CORR-5E2-3: a fetch of the limits, held while a newer notice lands, doesn't undo it
  const sf = await signIn(F);
  await post(sf, "/api/sync/v1/enable", {});
  ok((await put(sf, Buffer.from("f"))).status === 201, "(F's limits cached: issued 10, 1,000 bytes)");
  await new Promise((r) => setTimeout(r, 1200)); // (the cache is old: the next upload fetches)
  fake.limits.set(F, { ...sync(1000, 1 << 20), issued: 15 });
  let open;
  fake.limitsGate = new Promise((r) => (open = r));
  const upload = put(sf, Buffer.alloc(500, 5));
  await new Promise((r) => setTimeout(r, 200));
  const nb = JSON.stringify({ request_id: crypto.randomUUID(), account_id: F, issued: 20, limits: sync(1, 1 << 20) });
  ok((await (await signedPost(LIMITS_KEY, "/api/admin/limits", nb)).json()).applied === true, "(a notice, issued 20: 1 byte, while the fetch waits)");
  open();
  fake.limitsGate = null;
  ok((await upload).status === 507, "the fetch's older answer doesn't stand: the upload meets the notice's 1-byte limit (CORR-5E2-3)");
  // CORR-5E2-1: a purge while F's first document is being made
  const acctF = acctNs.get(acctNs.idFromName("acct:" + hashOf(F)));
  const sxf = await socket(sf);
  await hello(sxf, "device-f-purge01");
  const docY = "4444dddd6666";
  const dy = docNs.get(docNs.idFromName(`doc:${hashOf(F)}:${docY}`));
  await dy.hold({ name: `init:${docY}` });
  const firstY = sxf.ask(batch(docY, 1, [[1, pid(1, "clientFYFY"), [], "first"]], { kind: "board" }));
  await new Promise((r) => setTimeout(r, 50));
  ok((await del(sf, F)).status === 202, "(F: Delete my synced data, while its first document is being made)");
  // (within the test's 300 ms forward: after it, the held call would be refused, and the purge go on)
  await new Promise((r) => setTimeout(r, 120));
  ok((await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(F)).first())?.state === "deleting", "the purge waits while a call to a document can still commit");
  await dy.open({ name: `init:${docY}` });
  await firstY;
  let stF = null;
  for (let w = 0; w < 60 && stF !== "purged"; w++) {
    await new Promise((r) => setTimeout(r, 250));
    stF = (await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(F)).first())?.state;
  }
  ok(stF === "purged" && (await dy.pull({ account: F, epoch: 1, after: 0 }))?.error?.code === "unknown_doc", "and then the document made meanwhile is deleted too (CORR-5E2-1)");
  // CORR-5E2-2: a purge while an upload is outstanding
  const se = await signIn(E);
  const acctE = acctNs.get(acctNs.idFromName("acct:" + hashOf(E)));
  const late = await acctE.reserve({ account: E, sha256: sha(Buffer.from("late put")), size: 8 });
  ok(late?.ok?.key, "(an upload reserved, its bytes not yet in R2)");
  ok((await del(se, E)).status === 202, "(E: Delete my synced data, meanwhile)");
  // (within the test's 3 s reservation)
  await new Promise((r) => setTimeout(r, 300));
  ok((await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(E)).first())?.state === "deleting", "the purge waits while an upload is outstanding");
  await bucket.put(late.ok.key, "late put");
  const fin = await acctE.finalize({ account: E, id: late.ok.id, size: 8 });
  const iE = await acctE.inspect({});
  ok(fin?.error?.code === "deleting" && (iE === null || iE.reservations === 0), "a finalize during the purge is refused, and hands its object to the purge at once");
  let state = null;
  for (let w = 0; w < 60 && state !== "purged"; w++) {
    await new Promise((r) => setTimeout(r, 250));
    state = (await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(E)).first())?.state;
  }
  ok(state === "purged", "and then it finishes");
  ok((await bucket.head(late.ok.key)) === null && (await bucket.list({ prefix: `s/${hashOf(E).slice(0, 32)}/` })).objects.length === 0, "with the late upload's bytes gone (CORR-5E2-2)");
}

// ---- an upload that outlives its reservation, with the Worker's immediate delete off (CORR-5E2-2)
{
  const bucket = await mf.getR2Bucket("SHARE_BUCKET", "sync");
  const sg = await signIn(G);
  await post(sg, "/api/sync/v1/enable", {});
  const bytes = Buffer.from("late");
  let send2;
  const second = new Promise((r) => (send2 = r));
  const body = new ReadableStream({
    async start(c) {
      c.enqueue(bytes.subarray(0, 2));
      await second;
      try {
        c.enqueue(bytes.subarray(2));
        c.close();
      } catch {}
    },
  });
  const upload = fetchAt(SITE, `/api/sync/v1/blob/${sha(bytes)}`, { method: "PUT", headers: { cookie: sg, origin: SITE, "content-type": "application/octet-stream", "content-length": "4" }, body, duplex: "half" });
  await new Promise((r) => setTimeout(r, 200));
  ok((await del(sg, G)).status === 202, "(G: Delete my synced data, while an upload's bytes are still coming)");
  // (the test's reservation is 3 s and the cut-off a second before it: just after the cut-off, the
  // reservation is already given back; then, past the reservation's end, the rest of the bytes are sent)
  await new Promise((r) => setTimeout(r, 2300));
  const iG = await acctNs.get(acctNs.idFromName("acct:" + hashOf(G))).inspect({}).catch(() => null);
  ok(iG === null || iG.reservations === 0, "an upload cut off gives its reservation back at once");
  await new Promise((r) => setTimeout(r, 1200));
  send2();
  const res = await upload.then((r) => r.status).catch(() => "aborted");
  let state = null;
  for (let w = 0; w < 60 && state !== "purged"; w++) {
    await new Promise((r) => setTimeout(r, 250));
    state = (await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(G)).first())?.state;
  }
  await new Promise((r) => setTimeout(r, 500));
  ok(res === 408, `an upload still streaming at its cut-off is ended (${res}), before its reservation does`);
  ok(state === "purged" && (await bucket.list({ prefix: `s/${hashOf(G).slice(0, 32)}/` })).objects.length === 0, "and no object of it ever appears, though the purge finished and the Worker's own delete is off (CORR-5E2-2)");
}

// ---- the daily inventory: a late commit, whenever it lands (CORR-5E2-2, §9)
{
  const bucket = await mf.getR2Bucket("SHARE_BUCKET", "sync");
  // G's account is purged; a put that had sent its last byte commits only now, after the purge (astra's held commit)
  const lateG = `s/${hashOf(G).slice(0, 32)}/${"a".repeat(36)}`;
  await bucket.put(lateG, "late");
  // A's account is live again (turned on after its deletion): one of its keys is a holding, one is unknown
  const sa2 = await signIn(A);
  const kept = Buffer.from("A's file after re-enabling");
  ok((await put(sa2, kept)).status === 201, "(A uploads a file of its own)");
  const unknownA = `s/${hashOf(A).slice(0, 32)}/${"b".repeat(36)}`;
  await bucket.put(unknownA, "stray");
  await new Promise((r) => setTimeout(r, 1200)); // (the test's age threshold is 1 s; in a deployment, 2 days)
  const worker = await mf.getWorker("sync");
  // (the test's pages are 50 objects, 2 a run: run until the cursor wraps)
  for (let i = 0; i < 6; i++) await worker.scheduled({ cron: "17 3 * * *" });
  ok((await bucket.head(lateG)) === null, "the inventory deletes a late commit under a purged account's prefix, whenever it lands");
  ok((await bucket.head(unknownA)) === null, "and an object a live account doesn't know");
  const keys = (await bucket.list({ prefix: `s/${hashOf(A).slice(0, 32)}/` })).objects.map((o) => o.key);
  ok(keys.length === 1, "while the live account keeps the object it holds, and only that");
  // many distinct prefixes in a page (LIMIT-268-1): 230 objects, each under an account nobody has
  for (let i = 0; i < 230; i++) await bucket.put(`s/${i.toString(16).padStart(32, "0")}/${"d".repeat(36)}`, "x");
  await new Promise((r) => setTimeout(r, 1200));
  const runs = [];
  // (the scheduled handler's own stats: run syncScheduled through the test entry's route)
  for (let i = 0; i < 6; i++) {
    const r = await fetchAt(SITE, "/__test/inventory", { method: "POST" });
    runs.push(await r.json());
  }
  const left = (await bucket.list({ prefix: "s/0000000000000000000000000000", limit: 1000 })).objects.length;
  ok(runs.every((r) => r.pages <= 2 && r.calls <= 2 * 3 + 2 * (2 + 1 + 50 + 1 + 1)), "each run is bounded: the receipts' prune (2 kinds, at most 3 pages each), then at most 2 pages, and per page the cursor read, one list, one lookup, one call per live account, one delete, the cursor write");
  ok(runs[0].deleted <= 100 && runs.slice(0, 3).reduce((n, r) => n + r.deleted, 0) >= 230 && left === 0, `the cursor continues across runs until every page is done (${runs.map((r) => r.deleted).join(",")})`);
  // one account owning a whole page (LIMIT-268-2): knownKeys is set-wise
  const many = Array.from({ length: 1000 }, (_, i) => `s/${hashOf(A).slice(0, 32)}/${i.toString(16).padStart(36, "0")}`);
  const kk = await acctNs.get(acctNs.idFromName("acct:" + hashOf(A))).knownKeys({ keys: [...many, ...keys] });
  ok(kk.statements <= 11 && kk.known.length === 1 && kk.known[0] === keys[0], `knownKeys of 1,001 keys: ${kk.statements} statements, and it knows exactly the held one`);
  // LIMIT-SYNC-CRON-1: a run has a wall-clock deadline.  Past it no call starts; and a page whose
  // account call outlasts it is left whole (nothing of it deleted, its cursor unmoved) for the next run
  const inv = async (q = "") => JSON.parse(await (await fetchAt(SITE, "/__test/inventory" + q, {})).text());
  const r0 = await inv("?deadline_ms=0");
  ok(r0.stopped === true && r0.pages === 0 && r0.calls === 0 && r0.pruned === 0, "past the deadline no call starts, not even the prune's: " + JSON.stringify(r0));
  const cursor = async () => (await db.prepare("SELECT v FROM meta WHERE k = 'sync_inventory_cursor'").first())?.v ?? "";
  // every call counted (LIMIT-SYNC-CRON-1), on a page of 3 old objects under an account nobody has (a
  // test-only list prefix, the cursor reset around it): the prune's 2 statements (nothing left to
  // prune), then the cursor read, the list, the lookup, no account call, the delete, the cursor write
  await inv(); // (whatever receipts are due go first)
  const lone = "s/" + "f".repeat(32) + "/";
  for (let i = 0; i < 3; i++) await bucket.put(lone + i.toString(16).padStart(36, "0"), "x");
  await new Promise((r) => setTimeout(r, 1200));
  const savedCursor = await cursor();
  await db.prepare("DELETE FROM meta WHERE k = 'sync_inventory_cursor'").run();
  const rx = await inv("?prefix=" + lone);
  await db.prepare("INSERT INTO meta (k, v) VALUES ('sync_inventory_cursor', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(savedCursor).run();
  ok(rx.pruned === 0 && rx.pages === 1 && rx.deleted === 3 && rx.calls === 2 + 5 && !rx.stopped, "a page's calls are counted exactly, its cursor write too (2 + 5): " + JSON.stringify(rx));
  const strayA = `s/${hashOf(A).slice(0, 32)}/${"e".repeat(36)}`;
  await bucket.put(strayA, "stray, under a slow account");
  await new Promise((r) => setTimeout(r, 1200));
  const acctA = acctNs.get(acctNs.idFromName("acct:" + hashOf(A)));
  await acctA.testSlowKnown({ ms: 4000 });
  let slow = null;
  for (let i = 0; i < 40 && !slow; i++) {
    const c0 = await cursor();
    const t0 = Date.now();
    const r = await inv("?deadline_ms=600");
    if (r.stopped) slow = { r, ms: Date.now() - t0, moved: (await cursor()) !== c0 };
  }
  ok(slow !== null && slow.ms < 3000 && !slow.moved && (await bucket.head(strayA)) !== null, "a slow account object (4 s) ends the run at its deadline (0.6 s), not when the object answers: its page's cursor unmoved, nothing of it deleted: " + JSON.stringify(slow));
  await acctA.testSlowKnown({ ms: 0 });
  for (let i = 0; i < 40 && (await bucket.head(strayA)) !== null; i++) await inv();
  ok((await bucket.head(strayA)) === null && (await bucket.list({ prefix: `s/${hashOf(A).slice(0, 32)}/` })).objects.length === 1, "and once it answers again, a later run finishes the page: the stray is deleted, the held object kept");
  // CORR-00F-1: H's registration in D1 fails; no write is taken; the inventory never deletes a held file
  const sh = await signIn(H);
  const en = await post(sh, "/api/sync/v1/enable", {});
  ok(en.status === 503, "turning sync on fails if its D1 registration does");
  const hp = await put(sh, Buffer.from("H's file"));
  ok(hp.status === 403 && (await acctNs.get(acctNs.idFromName("acct:" + hashOf(H))).lifecycle())?.state === "registering", "and the account then takes no write: its object is registering, never confirmed (" + hp.status + ")");
  ok((await db.prepare("SELECT 1 AS x FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(H)).first()) === null && (await bucket.list({ prefix: `s/${hashOf(H).slice(0, 32)}/` })).objects.length === 0, "nothing of H's is in D1 or R2");
  // ---- the lifecycle (CORR-02C-1): the account object decides every enable and purge, one transaction
  // each; D1 is written after, only as its answer says, and its row only moves forward
  const acctE = acctNs.get(acctNs.idFromName("acct:" + hashOf(E)));
  const seE = await signIn(E);
  const rowOf = async (id) => db.prepare("SELECT state, generation, request_id FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(id)).first();
  const resume = (id, generation) => fetchAt(SITE, `/__test/register?account=${id}&generation=${generation}`, { method: "POST" });
  // a confirm of a generation the account object never made, or for another account, changes nothing (H: registering at 1)
  const acctH = acctNs.get(acctNs.idFromName("acct:" + hashOf(H)));
  const ahead2 = await acctH.confirm({ account: H, generation: 2 });
  const other = await acctH.confirm({ account: A, generation: 1 });
  ok(ahead2?.error?.code === "conflict" && other?.error?.code === "conflict" && (await acctH.lifecycle())?.state === "registering" && (await put(sh, Buffer.from("H's file, after"))).status === 403, "a confirm naming a generation not made, or another account, is refused; H stays registering");
  // CORR-A9B-1: a registration of E's generation 1, held past E's purge, can't make storage under it
  const regE = await rowOf(E);
  ok(regE?.state === "purged" && regE.generation === 1, "(E is purged; its row keeps the generation it had)");
  const staleE = await acctE.confirm({ account: E, generation: 1 });
  ok(staleE?.error?.code === "forbidden" && staleE.error.detail?.retired === 1 && (await put(seE, Buffer.from("E after a stale confirm"))).status === 403, "a late confirm of the purged generation is refused, as retired, and no write is taken (CORR-A9B-1)");
  const en2 = await post(seE, "/api/sync/v1/enable", {});
  const b2 = await en2.json();
  ok(en2.status === 200 && b2.state === "active" && b2.generation === 2, "turning sync on again: the account object makes the next generation, 2");
  const regE2 = await rowOf(E);
  ok(regE2?.state === "active" && regE2.generation === 2 && (await put(seE, Buffer.from("E after turning sync on"))).status === 201, "D1 records it, and the account takes writes under it");
  // CORR-DE7-1: two cycles. Generation 2 is purged, 3 is turned on and purged: a late confirm of 1, 2 or 3 is refused
  const purgeE = async () => {
    ok((await del(seE, E)).status === 202, "(E: Delete my synced data)");
    ok(await until(async () => (await rowOf(E))?.state === "purged" && (await acctE.lifecycle())?.record_pending === false), "(the purge finishes, and D1 records it)");
  };
  await purgeE();
  ok((await (await post(seE, "/api/sync/v1/enable", {})).json()).generation === 3, "(generation 3)");
  await purgeE();
  const stale = [];
  for (const g of [1, 2, 3]) stale.push((await acctE.confirm({ account: E, generation: g }))?.error?.detail?.retired ?? "admitted");
  ok(stale.join() === "3,3,3" && (await put(seE, Buffer.from("E after stale confirms"))).status === 403, "after two cycles, a late confirm of every retired generation is refused, and no write is taken (CORR-DE7-1): " + stale.join());
  const lc3 = await acctE.lifecycle();
  ok(lc3?.state === null && lc3.retired === 3, "(the account object is a tombstone: retired 3)");
  const en4 = await (await post(seE, "/api/sync/v1/enable", {})).json();
  ok(en4.generation === 4 && (await put(seE, Buffer.from("E, generation 4"))).status === 201, "and turning sync on again (generation 4) takes writes");
  // a registration of generation 3, held past all that, resumes: D1's row is at 4, and stays there
  const r3 = await resume(E, 3);
  const reg4a = await rowOf(E);
  ok(r3.status === 409 && reg4a?.state === "active" && reg4a.generation === 4, "a held registration of an older generation can't take D1's row back (" + r3.status + ")");
  // CORR-3ED-1: a purge of generation 3, held while 3 was purged and 4 turned on, arrives last; and one of 5, which no device was given
  const latePurge = await acctE.purge({ request_id: crypto.randomUUID(), kind: "self", generation: 3 });
  const ahead = await acctE.purge({ request_id: crypto.randomUUID(), kind: "self", generation: 5 });
  const noGen = await post(seE, "/api/sync/v1/delete", { confirm: "delete" });
  await new Promise((r) => setTimeout(r, 500));
  const reg4 = await rowOf(E);
  ok(latePurge.state === "stale" && ahead.state === "stale" && noGen.status === 400 && reg4?.state === "active" && reg4.generation === 4, "a purge of another generation, older or newer, is stale, and one naming none is refused: the live one is untouched (CORR-3ED-1)");
  ok((await put(seE, Buffer.from("E, generation 4, after the late purge"))).status === 201 && (await acctE.inspect({}))?.used > 0, "and generation 4's storage and writes are untouched");
  // CORR-02C-1, astra's trace: while generation 4 is being deleted, no newer generation can be made, so
  // none can be left behind its deletion; a purge naming a newer one is stale
  await acctE.holdPurge({ on: true });
  ok((await del(seE, E)).status === 202, "(E: Delete my synced data, generation 4, held)");
  const during = await post(seE, "/api/sync/v1/enable", {});
  const duringB = await during.json();
  const aheadDuring = await acctE.purge({ request_id: crypto.randomUUID(), kind: "self", generation: 5 });
  const lcDuring = await acctE.lifecycle();
  const regDuring = await rowOf(E);
  ok(during.status === 409 && duringB.error === "deleting" && aheadDuring.state === "stale" && lcDuring?.state === "deleting" && lcDuring.generation === 4 && regDuring?.state === "deleting" && regDuring.generation === 4,
    "an enable while generation 4 is being deleted is refused by the account object, and makes no generation, in it or in D1 (CORR-02C-1)");
  await acctE.holdPurge({ on: false });
  ok(await until(async () => (await rowOf(E))?.state === "purged" && (await acctE.lifecycle())?.retired === 4), "(the deletion of 4 finishes)");
  const en5 = await (await post(seE, "/api/sync/v1/enable", {})).json();
  ok(en5.generation === 5 && (await rowOf(E))?.generation === 5 && (await put(seE, Buffer.from("E, generation 5"))).status === 201, "afterwards, the next generation is 5, and takes writes");
  // a purge's D1 record that can't be written yet is written later, from the tombstone; a registration
  // meanwhile, of the next generation, is never touched by it
  await acctE.setFailRecord({ on: true });
  ok((await del(seE, E)).status === 202, "(E: Delete my synced data, generation 5, with D1's record failing)");
  ok(await until(async () => (await acctE.lifecycle())?.state === null), "(the deletion of 5 is done: a tombstone)");
  const lcPending = await acctE.lifecycle();
  ok(lcPending?.retired === 5 && lcPending.record_pending === true && lcPending.alarm !== null && (await rowOf(E))?.state === "deleting", "the tombstone keeps the D1 record still to write, with its alarm armed; D1 still says deleting");
  const en6 = await (await post(seE, "/api/sync/v1/enable", {})).json();
  ok(en6.generation === 6 && (await rowOf(E))?.state === "active" && (await rowOf(E))?.generation === 6, "turning sync on meanwhile: generation 6, recorded in D1 over 5's row");
  await acctE.setFailRecord({ on: false });
  ok(await until(async () => (await acctE.lifecycle())?.record_pending === false), "(5's record is written, from the alarm)");
  const reg6 = await rowOf(E);
  ok(reg6?.state === "active" && reg6.generation === 6 && (await put(seE, Buffer.from("E, generation 6"))).status === 201, "and it was for 5's row only: generation 6 is untouched and takes writes");
  await acctE.setFailRecord({ on: true });
  ok((await del(seE, E)).status === 202, "(E: Delete my synced data, generation 6, with D1's record failing)");
  ok(await until(async () => (await acctE.lifecycle())?.state === null), "(a tombstone)");
  await new Promise((r) => setTimeout(r, 900)); // (several retries, every one failing)
  const lcRetry = await acctE.lifecycle();
  ok(lcRetry?.record_pending === true && lcRetry.alarm !== null, "while D1 keeps failing, the tombstone keeps its alarm armed for the record");
  await acctE.setFailRecord({ on: false });
  ok(await until(async () => (await rowOf(E))?.state === "purged" && (await acctE.lifecycle())?.record_pending === false), "with nothing else happening, the tombstone writes the record later: D1 says purged");
  // two purges while D1's record fails: generation 7's, then 8's, registered in the account object but
  // never in D1; 8's record replaces 7's, and covers its row (LIMIT-B92-1)
  // (and two enables at once, for 7: one generation, both on)
  const both = await Promise.all([post(seE, "/api/sync/v1/enable", {}), post(seE, "/api/sync/v1/enable", {})]);
  const bothB = await Promise.all(both.map((r) => r.json()));
  ok(both.every((r) => r.status === 200) && bothB.every((b) => b.state === "active" && b.generation === 7) && (await rowOf(E))?.generation === 7 && (await put(seE, Buffer.from("E, generation 7"))).status === 201, "two enables at once get the same generation, 7, and both answer active: " + JSON.stringify(bothB));
  await acctE.setFailRecord({ on: true });
  ok((await del(seE, E)).status === 202 && (await until(async () => (await acctE.lifecycle())?.state === null)), "(7 is deleted, its record failing: D1 still says deleting)");
  const e8 = await acctE.enable({ account: E, hash: hashOf(E) });
  ok(e8?.ok?.generation === 8 && e8.ok.state === "registering", "(the account object makes 8, registering; it never reaches D1)");
  ok((await acctE.purge({ request_id: crypto.randomUUID(), kind: "self", generation: 8 })).state === "deleting" && (await until(async () => (await acctE.lifecycle())?.retired === 8)), "(8 is deleted too)");
  ok((await rowOf(E))?.state === "deleting" && (await rowOf(E))?.generation === 7 && (await acctE.lifecycle())?.record_pending === true, "(D1: 7, deleting; both records wait)");
  await acctE.setFailRecord({ on: false });
  ok(await until(async () => (await acctE.lifecycle())?.record_pending === false), "(the records are written)");
  ok((await rowOf(E))?.state === "purged" && (await rowOf(E))?.generation === 7, "8's record covers 7's, coalesced: D1's row of 7 is purged");
  // LIMIT-B92-1: many cycles while D1's records fail: the tombstone keeps one record, of constant size
  await acctE.setFailRecord({ on: true });
  for (let g = 9; g <= 14; g++) {
    ok((await (await post(seE, "/api/sync/v1/enable", {})).json()).generation === g && (await del(seE, E)).status === 202 && (await until(async () => (await acctE.lifecycle())?.state === null && (await acctE.lifecycle())?.retired === g)), `(cycle: generation ${g} on and deleted, D1's record failing)`);
  }
  const lcMany = await acctE.lifecycle();
  ok(lcMany?.meta_rows === 2 && lcMany.record_pending === true && (await rowOf(E))?.generation === 14 && (await rowOf(E))?.state === "deleting", "after 6 cycles with D1 failing, the tombstone holds 2 rows (retired, one record): " + lcMany?.meta_rows);
  // LIMIT-B92-2: each failure waits a capped exponential backoff with jitter; one D1 call per attempt
  const w0 = lcMany.record_waits.length, c0 = lcMany.record_calls, t0 = lcMany.record_tries;
  await new Promise((r) => setTimeout(r, 2500));
  const lcB = await acctE.lifecycle();
  const waits = lcB.record_waits.slice(w0);
  const bk = (t) => Math.min(4000, 200 * 2 ** t);
  ok(waits.length >= 2 && waits.every((w, i) => w >= bk(t0 + i + 1) / 2 - 1 && w <= bk(t0 + i + 1)) && lcB.record_calls - c0 === waits.length, "retries back off exponentially, with jitter, one D1 call each: " + JSON.stringify({ t0, waits }));
  await acctE.setRecordTries({ tries: 30 });
  const w1 = lcB.record_waits.length + (waits.length ? 0 : 0);
  ok(await until(async () => (await acctE.lifecycle()).record_waits.length > (await acctE.lifecycle()).record_waits.length - 1 && (await acctE.lifecycle()).record_tries > 30, 8000), "(an attempt after 30 failures)");
  const capW = (await acctE.lifecycle()).record_waits.at(-1);
  ok(capW >= 2000 - 1 && capW <= 4000 && w1 >= 0, "and the backoff is capped (test cap 4 s): " + capW);
  const lcCap = await acctE.lifecycle();
  ok(lcCap.alarm !== null && lcCap.alarm >= lcCap.record_retry_at - 5, "the alarm is armed for the record's own retry time, not sooner: " + JSON.stringify([lcCap.alarm - Date.now(), lcCap.record_retry_at - Date.now()]));
  await acctE.wakeNow();
  await new Promise((r) => setTimeout(r, 400));
  const lcEarly = await acctE.lifecycle();
  ok(lcEarly.record_calls === lcCap.record_calls && lcEarly.alarm >= lcEarly.record_retry_at - 5, "an alarm before the record is due makes no D1 call, and arms again for it");
  await acctE.setFailRecord({ on: false });
  ok(await until(async () => (await acctE.lifecycle())?.record_pending === false, 10000), "D1 recovers: the record is written at its next attempt");
  ok((await rowOf(E))?.state === "purged" && (await rowOf(E))?.generation === 14 && (await acctE.lifecycle())?.meta_rows === 1, "D1's row of 14 is purged; the tombstone holds only retired");
  // CoCalc's purge of an account with no storage: every generation the object retired is purged in D1,
  // and nothing more (a stray row left active, as a lost write would leave it)
  await db.prepare("UPDATE sync_accounts SET state = 'active' WHERE account_hash = ?1").bind(hashOf(E)).run();
  const ridE = crypto.randomUUID();
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: E, request_id: ridE }))).status === 202, "(CoCalc purges E, which holds nothing)");
  const regE6 = await rowOf(E);
  ok(regE6?.state === "purged" && regE6.generation === 14 && regE6.request_id === ridE, "the account object answers none, retired 14: D1's row of 14 is purged, under CoCalc's request id");

  // CORR-A62-1: I's first enable is answered (generation 1, registering) and held before D1; a delete; the held registration arrives last
  const si = await signIn(I);
  const acctI = acctNs.get(acctNs.idFromName("acct:" + hashOf(I)));
  const held = await (await post(si, "/api/sync/v1/enable", {})).json();
  const lcI = await acctI.lifecycle();
  ok(held.held === 1 && lcI?.state === "registering" && lcI.generation === 1 && (await rowOf(I)) === null, "(I's first enable: generation 1, registering, not yet in D1, held)");
  ok((await put(si, Buffer.from("I's early file"))).status === 403 && (await socket(si)).status === 403, "a registering account takes no write and no socket");
  const dI = await post(si, "/api/sync/v1/delete", { confirm: "delete", generation: held.held });
  ok(dI.status === 202 && (await dI.json()).state === "deleting", "(I: Delete my synced data, generation 1, while registering)");
  ok(await until(async () => (await acctI.lifecycle())?.state === null && (await acctI.lifecycle())?.retired === 1), "(the deletion finishes: a tombstone, retired 1)");
  const lateI = await resume(I, 1);
  const lateIB = await lateI.json();
  const regI = await rowOf(I);
  ok(lateI.status === 403 && lateIB.retired === 1 && regI?.state === "purged" && regI.generation === 1 && (await put(si, Buffer.from("I's file"))).status === 403,
    "the held registration, arriving after, is refused as retired, and the row it made is marked purged; no write is taken (CORR-A62-1)");
  const enI = await (await post(si, "/api/sync/v1/enable", {})).json();
  ok(enI.generation === 2 && enI.state === "active" && (await rowOf(I))?.generation === 2 && (await put(si, Buffer.from("I's file, generation 2"))).status === 201, "a fresh enable makes generation 2, which takes writes");
  // K: a registration held while CoCalc purges the account, and resumed during the purge, then again after it
  const sk = await signIn(K);
  const acctK = acctNs.get(acctNs.idFromName("acct:" + hashOf(K)));
  ok((await (await post(sk, "/api/sync/v1/enable", {})).json()).held === 1, "(K's first enable: generation 1, held before D1)");
  await acctK.holdPurge({ on: true });
  const ridK = crypto.randomUUID();
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: K, request_id: ridK }))).status === 202 && (await acctK.lifecycle())?.state === "deleting", "(CoCalc purges K while it registers: the account object, not D1, has it)");
  const midK = await resume(K, 1);
  const midKB = await midK.json();
  const regMidK = await rowOf(K);
  ok(midK.status === 409 && midKB.error === "deleting" && regMidK?.generation === 1, "the held registration, resumed during the purge, is refused (deleting): its row exists, and nothing is taken");
  await acctK.holdPurge({ on: false });
  ok(await until(async () => (await rowOf(K))?.state === "purged"), "the purge's record, from the tombstone, marks that row purged");
  const stK = await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridK}`);
  ok(stK.status === 200 && (await stK.json()).state === "purged", "and CoCalc's status finds it by its own request id");
  const lastK = await resume(K, 1);
  const regLastK = await rowOf(K);
  ok(lastK.status === 409 && regLastK?.state === "purged" && regLastK.generation === 1 && [401, 403].includes((await put(sk, Buffer.from("K's file"))).status), "the same registration once more, after: D1 stays purged, nothing is taken (the purge signed K out too)");
  // the guards on late D1 writes, staged with D1 answers held at the Worker (astra's staging of item 11)
  const gateSet = (name, on) => fetchAt(SITE, `/__test/gate?name=${name}&on=${on ? 1 : 0}`, { method: "POST" });
  const sl = await signIn(L);
  const acctL = acctNs.get(acctNs.idFromName("acct:" + hashOf(L)));
  ok((await (await post(sl, "/api/sync/v1/enable", {})).json()).generation === 1, "(L: generation 1)");
  await gateSet("record-deleting", true);
  const dL1 = post(sl, "/api/sync/v1/delete", { confirm: "delete", generation: 1 });
  ok(await until(async () => (await acctL.lifecycle())?.state === null && (await rowOf(L))?.state === "purged"), "(the purge of 1 finishes and its record marks the row purged, while the deletion's own D1 write waits)");
  await gateSet("record-deleting", false);
  ok((await dL1).status === 202 && (await rowOf(L))?.state === "purged", "the deletion's late `deleting` write doesn't take a purged row back");
  await gateSet("record-none", true);
  const dL2 = post(sl, "/api/sync/v1/delete", { confirm: "delete", generation: 1 });
  await new Promise((r) => setTimeout(r, 200));
  const enL2 = await (await post(sl, "/api/sync/v1/enable", {})).json();
  await gateSet("record-none", false);
  const rL2 = await rowOf(L);
  ok(enL2.generation === 2 && (await dL2).status === 202 && rL2?.state === "active" && rL2.generation === 2 && (await put(sl, Buffer.from("L, generation 2"))).status === 201, "a late `none` write (retired 1) leaves generation 2, registered meanwhile, alone " + JSON.stringify([enL2, rL2]));
  await gateSet("record-deleting", true);
  await acctL.setFailRecord({ on: true });
  const dL3 = post(sl, "/api/sync/v1/delete", { confirm: "delete", generation: 2 });
  ok(await until(async () => (await acctL.lifecycle())?.retired === 2 && (await acctL.lifecycle())?.state === null) && (await rowOf(L))?.state === "active", "(2 is deleted; its D1 writes wait or fail, so its row still says active)");
  await gateSet("register-cleanup", true);
  const late2 = resume(L, 2);
  await new Promise((r) => setTimeout(r, 300));
  const enL3 = await (await post(sl, "/api/sync/v1/enable", {})).json();
  await gateSet("register-cleanup", false);
  const late2r = await late2;
  const rL3 = await rowOf(L);
  ok(enL3.generation === 3 && late2r.status === 403 && rL3?.state === "active" && rL3.generation === 3 && (await put(sl, Buffer.from("L, generation 3"))).status === 201, "a held registration of 2, refused as retired, marks only 2's row: generation 3, registered meanwhile, is untouched " + JSON.stringify([enL3, late2r.status, rL3]));
  await acctL.setFailRecord({ on: false });
  await gateSet("record-deleting", false);
  await dL3;
  ok(await until(async () => (await acctL.lifecycle())?.record_pending === false) && (await rowOf(L))?.state === "active" && (await rowOf(L))?.generation === 3, "and 2's late writes, when they land, leave 3 alone");
  // LIMIT-BF3-1: a pending record with no D1 bound waits its backoff, as a failure does; its alarm doesn't spin
  await acctL.setNoDb({ on: true });
  ok((await post(sl, "/api/sync/v1/delete", { confirm: "delete", generation: 3 })).status === 202 && (await until(async () => (await acctL.lifecycle())?.state === null && (await acctL.lifecycle())?.record_tries >= 1)), "(L: 3 is deleted with no D1 bound: its record waits)");
  const nd0 = await acctL.lifecycle();
  await acctL.wakeNow();
  await new Promise((r) => setTimeout(r, 1000));
  const nd1 = await acctL.lifecycle();
  ok(nd1.record_pending && nd1.record_calls - nd0.record_calls <= 3 && nd1.record_tries >= nd0.record_tries && nd1.record_calls - nd0.record_calls === nd1.record_tries - nd0.record_tries && nd1.alarm !== null && nd1.alarm >= nd1.record_retry_at - 5, "with no D1 bound, an alarm doesn't re-arm at once: at most a backed-off attempt or two in a second, the alarm at the record's retry: " + JSON.stringify([nd1.record_calls - nd0.record_calls, nd1.record_tries]));
  await acctL.setNoDb({ on: false });
  ok(await until(async () => (await acctL.lifecycle())?.record_pending === false && (await rowOf(L))?.state === "purged"), "once D1 is bound again, the record is written at its next attempt");
  // CORR-BF3-1 (astra's trace): a self-delete's record fails; the next generation, made in the account
  // object but never in D1, is purged by CoCalc; the coalesced record then still answers CoCalc's id
  ok((await (await post(sl, "/api/sync/v1/enable", {})).json()).generation === 4, "(L: generation 4)");
  await acctL.setFailRecord({ on: true });
  ok((await post(sl, "/api/sync/v1/delete", { confirm: "delete", generation: 4 })).status === 202 && (await until(async () => (await acctL.lifecycle())?.state === null && (await acctL.lifecycle())?.retired === 4)), "(4 is deleted by its owner; D1's record fails: the row says deleting, under the self id)");
  ok((await acctL.enable({ account: L, hash: hashOf(L) }))?.ok?.state === "registering", "(the account object makes 5, registering; it never reaches D1)");
  const ridL = crypto.randomUUID();
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: L, request_id: ridL }))).status === 202 && (await until(async () => (await acctL.lifecycle())?.retired === 5)), "(CoCalc purges L: 5 is deleted, and the account fenced)");
  await acctL.setFailRecord({ on: false });
  ok(await until(async () => (await acctL.lifecycle())?.record_pending === false), "(the coalesced record is written)");
  const stL = await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridL}`);
  const stLB = await stL.json();
  const rowL = await rowOf(L);
  ok(stL.status === 200 && stLB.state === "purged" && rowL?.state === "purged" && rowL.generation === 4, "CoCalc's status finds its request by its own id though its generation never reached D1; the row stays at 4 (CORR-BF3-1): " + JSON.stringify([stL.status, rowL]));
  const ridL2 = crypto.randomUUID();
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: L, request_id: ridL2 }))).status === 202, "(CoCalc purges L again, with a new id: the object holds nothing)");
  const stL2 = await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridL2}`);
  ok(stL2.status === 200 && (await stL2.json()).state === "purged", "a repeated purge, answered none, is found by its own id too, though the row was purged already");
  // CORR-1C2-1: each request keeps its own receipt; a later one, or a retry, changes no other's
  const stL1b = await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridL}`);
  ok(stL1b.status === 200 && (await stL1b.json()).state === "purged", "the earlier request, polled after the later one, is still found: 200 purged (CORR-1C2-1)");
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: L, request_id: ridL }))).status === 202, "(CoCalc retries the first request, same id)");
  const [stR, stR2] = await Promise.all([signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridL}`), signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridL2}`)]);
  const stRB = await stR.json();
  ok(stR.status === 200 && stRB.state === "purged" && stR2.status === 200 && (await stR2.json()).state === "purged", "a retry answers its own receipt, and the later request's is untouched");
  const rcpt = await db.prepare("SELECT request_id, state FROM sync_admin_requests WHERE account_hash = ?1 ORDER BY created").bind(hashOf(L)).all();
  ok(rcpt.results.length === 2 && rcpt.results.every((x) => x.state === "purged"), "one receipt per request id, a retry adding none: " + JSON.stringify(rcpt.results));
  // their lifetime: pruned by the daily job once past it (test: 2 s after finishing; 30 days deployed)
  // (aged deterministically: finished 100 s ago, well past the test's 2 s lifetime)
  await db.prepare("UPDATE sync_admin_requests SET finished = finished - 100 WHERE account_hash = ?1").bind(hashOf(L)).run();
  const invL = await (await fetchAt(SITE, "/__test/inventory", {})).text();
  ok((await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridL}`)).status === 404 && (await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridL2}`)).status === 404 && (await db.prepare("SELECT COUNT(*) AS n FROM sync_admin_requests WHERE account_hash = ?1").bind(hashOf(L)).first()).n === 0, "past their polling lifetime, the daily job prunes the receipts " + JSON.stringify([Math.floor(Date.now() / 1000), (await db.prepare("SELECT * FROM sync_admin_requests WHERE account_hash = ?1").bind(hashOf(L)).all()).results, await invL]));
  // CORR-E0D-1: a request id names one account for good. O's purge is held (deleting, its file still
  // there); CoCalc's same id for another account, P, is refused before anything changes
  const bkt = await mf.getR2Bucket("SHARE_BUCKET", "sync");
  const so = await signIn(O);
  const acctO = acctNs.get(acctNs.idFromName("acct:" + hashOf(O)));
  const acctP = acctNs.get(acctNs.idFromName("acct:" + hashOf(P)));
  ok((await post(so, "/api/sync/v1/enable", {})).status === 200 && (await put(so, Buffer.from("O's file"))).status === 201, "(O: on, with a file)");
  await acctO.holdPurge({ on: true });
  const ridO = crypto.randomUUID();
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: O, request_id: ridO }))).status === 202 && (await acctO.lifecycle())?.state === "deleting", "(CoCalc purges O, request R: held, deleting)");
  const cross = await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: P, request_id: ridO }));
  const crossB = await cross.json();
  const rcO = await db.prepare("SELECT account_hash, state FROM sync_admin_requests WHERE request_id = ?1").bind(ridO).first();
  const stO = await (await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridO}`)).json();
  const lcP = await acctP.lifecycle();
  ok(cross.status === 409 && crossB.error === "conflict" && rcO?.account_hash === hashOf(O) && rcO.state === "deleting" && stO.state === "deleting" && lcP?.deleted === false && (await bkt.list({ prefix: `s/${hashOf(O).slice(0, 32)}/` })).objects.length > 0,
    "the same id for another account is refused (409) before its account object is asked: R's receipt still names O, deleting, and O's file is still there (CORR-E0D-1): " + JSON.stringify([cross.status, rcO, stO.state, lcP]));
  await acctO.holdPurge({ on: false });
  ok(await until(async () => (await (await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridO}`)).json()).state === "purged") && (await bkt.list({ prefix: `s/${hashOf(O).slice(0, 32)}/` })).objects.length === 0, "and R completes only when O's own purge does, its file gone");
  // LIMIT-233-1: every purge is admitted (sharing's deletion never waits on sync); the receipts are
  // bounded by total: at most 8 an account, a new id evicting the oldest, and none for an account that
  // never synced
  const nowS = () => Math.floor(Date.now() / 1000);
  const ridsL = [];
  for (let i = 0; i < 10; i++) {
    const id = crypto.randomUUID();
    ridsL.push(id);
    ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: L, request_id: id }))).status === 202, `(CoCalc purges L again, request ${i + 1} of 10: admitted)`);
  }
  const keptL = (await db.prepare("SELECT request_id FROM sync_admin_requests WHERE account_hash = ?1").bind(hashOf(L)).all()).results.map((x) => x.request_id);
  const stFirst = await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridsL[0]}`);
  const stLast = await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridsL[9]}`);
  ok(keptL.length === 8 && ridsL.slice(2).every((id) => keptL.includes(id)) && stFirst.status === 404 && stLast.status === 200, "10 requests for one account: all admitted, the newest 8 receipts kept, the oldest evicted: " + keptL.length);
  const ridRetry = ridsL[5];
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: L, request_id: ridRetry }))).status === 202 && (await db.prepare("SELECT COUNT(*) AS n FROM sync_admin_requests WHERE account_hash = ?1").bind(hashOf(L)).first()).n === 8 && (await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridsL[2]}`)).status === 200, "a retried id evicts nothing");
  const ridP = crypto.randomUUID();
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: P, request_id: ridP }))).status === 202 && (await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridP}`)).status === 404 && (await db.prepare("SELECT COUNT(*) AS n FROM sync_admin_requests WHERE account_hash = ?1").bind(hashOf(P)).first()).n === 0 && (await acctP.lifecycle())?.deleted === true,
    "an account that never synced is purged (and fenced), and keeps no receipt");
  // CORR-5D0-1: the status names the account, and the account object answers whenever no receipt says
  // purged: certain for every case the adapter meets
  const status = async (rid, acct) => { const r = await signedGet(PURGE_KEY, `/api/admin/sync-purge/${rid}${acct ? "/" + acct : ""}`); return [r.status, await r.json()]; };
  const [sP, bP] = await status(ridP, P);
  ok(sP === 200 && bP.state === "never_synced" && bP.source === "account", "never synced: 200 never_synced, from the account object (done: nothing to wait for): " + JSON.stringify(bP));
  const [sE0, bE0] = await status(ridsL[0], L);
  ok(sE0 === 200 && bE0.state === "purged" && bE0.source === "account", "completed, then its receipt evicted: 200 purged, from the account object: " + JSON.stringify(bE0));
  const [sNo, bNo] = await status(crypto.randomUUID(), crypto.randomUUID());
  ok(sNo === 404 && bNo.state === "not_requested", "an account no CoCalc purge has reached: 404 not_requested (send it again), never done");
  const [sX] = await status(ridsL[3], P);
  ok(sX === 409, "a request id asked about under another account: 409");
  // the object can't be reached: nothing recorded, 503 for CoCalc to send it again; no receipt left
  const ridRF = crypto.randomUUID();
  const rf = await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: RF, request_id: ridRF }));
  ok(rf.status === 503 && (await rf.json()).error === "busy" && (await db.prepare("SELECT COUNT(*) AS n FROM sync_admin_requests WHERE account_hash = ?1").bind(hashOf(RF)).first()).n === 0 && (await status(ridRF, RF))[0] === 404,
    "a purge whose account object can't be reached answers 503, keeps no receipt, and its status is 404 not_requested");
  // pending, then evicted: Q's purge is held; 8 more ids evict R's receipt; the account object still says deleting
  const sq = await signIn(Q);
  const acctQ = acctNs.get(acctNs.idFromName("acct:" + hashOf(Q)));
  ok((await post(sq, "/api/sync/v1/enable", {})).status === 200 && (await put(sq, Buffer.from("Q's file"))).status === 201, "(Q: on, with a file)");
  await acctQ.holdPurge({ on: true });
  const ridQ = crypto.randomUUID();
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: Q, request_id: ridQ }))).status === 202 && (await status(ridQ, Q))[1].state === "deleting", "(CoCalc purges Q, request R, held: deleting)");
  for (let i = 0; i < 8; i++) await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: Q, request_id: crypto.randomUUID() }));
  const [sQ, bQ] = await status(ridQ, Q);
  const rcQ = await db.prepare("SELECT 1 AS x FROM sync_admin_requests WHERE request_id = ?1").bind(ridQ).first();
  ok(rcQ === null && sQ === 200 && bQ.state === "deleting" && bQ.source === "account", "pending, then its receipt evicted: still 200 deleting, from the account object, never done: " + JSON.stringify(bQ));
  await acctQ.holdPurge({ on: false });
  ok(await until(async () => (await status(ridQ, Q))[1].state === "purged"), "and purged once the account object is done");
  // CORR-E9C-1: one new id for two accounts at once, both past the point a read would have been; the id
  // is bound before any account object acts, so the one refused is never touched
  const ss1 = await signIn(S1);
  const acctS1 = acctNs.get(acctNs.idFromName("acct:" + hashOf(S1)));
  const acctS2 = acctNs.get(acctNs.idFromName("acct:" + hashOf(S2)));
  ok((await post(ss1, "/api/sync/v1/enable", {})).status === 200 && (await put(ss1, Buffer.from("S1's file"))).status === 201, "(S1: on, with a file)");
  const race = async (first, second) => {
    await gateSet("purge-bound", true);
    const rid = crypto.randomUUID();
    const p1 = signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: first, request_id: rid }));
    await new Promise((r) => setTimeout(r, 150));
    const p2 = signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: second, request_id: rid }));
    await new Promise((r) => setTimeout(r, 300));
    await gateSet("purge-bound", false);
    return [await p1, await p2];
  };
  // (1) never-synced S2 binds the id first; S1, with a file, is refused and never touched
  const [r1a, r1b] = await race(S2, S1);
  const l1S1 = await acctS1.lifecycle();
  ok(r1a.status === 202 && r1b.status === 409 && (await acctS2.lifecycle())?.deleted === true && l1S1?.deleted === false && l1S1.state === "active" && (await put(ss1, Buffer.from("S1's file, still on"))).status === 201,
    "one new id for two accounts at once, both held after binding: the second (S1, with data) gets 409, its account object untouched, still on and taking writes (CORR-E9C-1): " + JSON.stringify({ a: r1a.status, b: r1b.status, l1S1 }));
  // (2) S1 binds a new id first; never-synced S3 is refused, and not fenced either
  const S3 = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
  const acctS3 = acctNs.get(acctNs.idFromName("acct:" + hashOf(S3)));
  const [r2a, r2b] = await race(S1, S3);
  ok(r2a.status === 202 && r2b.status === 409 && (await acctS1.lifecycle())?.deleted === true && (await acctS3.lifecycle())?.deleted === false,
    "and the other way round: a never-synced account refused (409) is not fenced: " + JSON.stringify({ a: r2a.status, b: r2b.status, s3: await acctS3.lifecycle() }));
  await db.prepare("DELETE FROM sync_admin_requests WHERE account_hash = ?1").bind(hashOf(L)).run();
  // the prune drains a backlog beyond one run's capacity (test: 2 kinds x 3 pages x 50 = 300 a run)
  await new Promise((r) => setTimeout(r, 1100));
  await (await fetchAt(SITE, "/__test/inventory", {})).text(); // (whatever is due now goes first)
  for (let i = 0; i < 400; i++) await db.prepare("INSERT INTO sync_admin_requests (request_id, account_hash, state, created, finished) VALUES (?1, 'seed', 'purged', ?2, ?2)").bind(`seed-done-${i}`, nowS() - 100).run();
  for (let i = 0; i < 400; i++) await db.prepare("INSERT INTO sync_admin_requests (request_id, account_hash, state, created) VALUES (?1, 'seed', 'deleting', ?2)").bind(`seed-open-${i}`, nowS() - 100).run();
  const seedLeft = async () => (await db.prepare("SELECT COUNT(*) AS n FROM sync_admin_requests WHERE account_hash = 'seed'").first()).n;
  const runsP = [];
  for (let i = 0; i < 3; i++) {
    const r = JSON.parse(await (await fetchAt(SITE, "/__test/inventory", {})).text());
    runsP.push([r.pruned, await seedLeft()]);
  }
  ok(runsP.every(([n]) => n <= 300) && runsP[0][0] === 300 && runsP[2][1] === 0, "a backlog of 800 expired receipts drains in 3 runs, at most 300 each: " + JSON.stringify(runsP));
  // each prune and the cap's count use their own index
  const plan = async (sql, ...b) => JSON.stringify((await db.prepare("EXPLAIN QUERY PLAN " + sql).bind(...b).all()).results.map((r) => r.detail));
  const pDone = await plan("SELECT request_id FROM sync_admin_requests WHERE state = 'purged' AND finished < ?1 LIMIT ?2", 1, 1);
  const pOpen = await plan("SELECT request_id FROM sync_admin_requests WHERE state = 'deleting' AND created < ?1 LIMIT ?2", 1, 1);
  const pAcct = await plan("SELECT request_id FROM sync_admin_requests WHERE account_hash = ?1 ORDER BY rowid DESC LIMIT -1 OFFSET 7", "x");
  ok(pDone.includes("sync_admin_requests_finished") && pOpen.includes("sync_admin_requests_open") && pAcct.includes("sync_admin_requests_account") && !/SCAN sync_admin_requests(?! USING)/.test(pDone + pOpen + pAcct), "the query plans use their indexes, no table scan: " + [pDone, pOpen, pAcct].join(" | "));
  // an account with no row at all: N registers in the account object only; CoCalc purges it; its
  // receipt is completed by the record, though no row ever existed
  const acctN = acctNs.get(acctNs.idFromName("acct:" + hashOf(N)));
  ok((await acctN.enable({ account: N, hash: hashOf(N) }))?.ok?.state === "registering" && (await rowOf(N)) === null, "(N: generation 1, registering, no row)");
  const ridN = crypto.randomUUID();
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: N, request_id: ridN }))).status === 202 && (await until(async () => (await acctN.lifecycle())?.state === null && (await acctN.lifecycle())?.record_pending === false)), "(CoCalc purges N)");
  const stN = await signedGet(PURGE_KEY, `/api/admin/sync-purge/${ridN}`);
  // (the body read at once, before another call to the Worker)
  const stNB = await stN.json();
  const rowN = await rowOf(N);
  ok(stN.status === 200 && stNB.state === "purged" && rowN === null, "CoCalc's status finds it by its receipt: purged, with no row ever made");
  // CORR-B92-1: CoCalc's purge leaves the account deleted for good, storage or none: an enable or a
  // request already past its session check (astra's probe) is refused when it arrives
  const sm = await signIn(M);
  const acctM = acctNs.get(acctNs.idFromName("acct:" + hashOf(M)));
  ok((await signedPost(PURGE_KEY, "/api/admin/purge", JSON.stringify({ account_id: M, request_id: crypto.randomUUID() }))).status === 202, "(CoCalc purges M, which never synced)");
  const lcM = await acctM.lifecycle();
  const lateEnM = await acctM.enable({ account: M, hash: hashOf(M) });
  const lateResM = await acctM.reserve({ account: M, sha256: sha(Buffer.from("m")), size: 1 });
  ok(lcM?.deleted === true && lcM.state === null && lateEnM?.error?.code === "forbidden" && lateResM?.error?.code === "forbidden" && (await acctM.lifecycle())?.state === null && (await rowOf(M)) === null,
    "an enable and an upload that were past their session check, arriving after, are refused: no storage, no row");
  ok([401, 403].includes((await post(sm, "/api/sync/v1/enable", {})).status) && (await acctM.lifecycle())?.state === null, "and so is every later enable");
  const acctB = acctNs.get(acctNs.idFromName("acct:" + hashOf(B)));
  const lateEnB = await acctB.enable({ account: B, hash: hashOf(B) });
  const lateConfB = await acctB.confirm({ account: B, generation: 2 });
  ok((await acctB.lifecycle())?.deleted === true && lateEnB?.error?.code === "forbidden" && lateConfB?.error?.code === "forbidden" && (await acctB.lifecycle())?.state === null, "an account CoCalc deleted with storage keeps the fence through its tombstone: a late enable or confirm is refused");
  // and a fresh object is left alone, whatever its account
  const fresh = `s/${hashOf(G).slice(0, 32)}/${"c".repeat(36)}`;
  await bucket.put(fresh, "fresh");
  await worker.scheduled({ cron: "17 3 * * *" });
  ok((await bucket.head(fresh)) !== null, "an object younger than the threshold is never touched (an upload may be finishing)");
}

// ---- the one storage budget for sharing and sync (§6.1)
{
  const L = 10_000;
  const sharePut = (session, bytes) => fetchAt(SITE, `/api/share/blob/${sha(bytes)}`, { method: "PUT", headers: { cookie: session, origin: SITE, "content-type": "application/octet-stream" }, body: bytes });
  const claimOf = async (id) => (await db.prepare("SELECT claim_bytes FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(id)).first())?.claim_bytes;
  const sharingOf = async (id) => (await db.prepare("SELECT (SELECT COALESCE(SUM(size), 0) FROM holdings WHERE account_id = ?1) + (SELECT COALESCE(SUM(manifest_bytes), 0) FROM versions WHERE owner = ?1) + (SELECT COALESCE(SUM(bytes), 0) FROM reservations WHERE account_id = ?1 AND expires > ?2) AS n").bind(id, Math.floor(Date.now() / 1000)).first()).n;
  // T1: one sharing upload and one sync upload, each fitting alone, not both, at once
  const st1 = await signIn(T1);
  ok((await post(st1, "/api/sync/v1/enable", {})).status === 200, "(T1: sync on, storage_bytes 10,000 for both)");
  const [sh1, sy1] = await Promise.all([sharePut(st1, Buffer.alloc(6000, 11)), put(st1, Buffer.alloc(6000, 12))]);
  const won = [sh1.status === 200 || sh1.status === 201, sy1.status === 201];
  const tot1 = (await sharingOf(T1)) + (await claimOf(T1));
  ok(won.filter(Boolean).length === 1 && tot1 <= L && [413, 507].includes(won[0] ? sy1.status : sh1.status),
    "a sharing upload and a sync upload at the edge, at once: exactly one goes, the other is refused, and sharing + claim stays within storage_bytes: " + JSON.stringify({ sharing: sh1.status, sync: sy1.status, tot1 }));
  // T3: sync's claim holds slack it doesn't use; sharing at the edge asks it back, once, and goes
  const st3 = await signIn(T3);
  const acctT3 = acctNs.get(acctNs.idFromName("acct:" + hashOf(T3)));
  ok((await post(st3, "/api/sync/v1/enable", {})).status === 200, "(T3: sync on)");
  const r3 = await acctT3.reserve({ account: T3, sha256: sha(Buffer.from("t3 slack")), size: 8000 });
  await acctT3.abandon({ id: r3.ok.id });
  const b3 = await acctT3.budget();
  ok(r3?.ok?.id && b3.claim >= 8000 && b3.files === 0 && (await claimOf(T3)) === b3.claim, "(T3: an upload reserved and abandoned leaves the claim holding " + b3.claim + " it doesn't use)");
  const sh3 = await sharePut(st3, Buffer.alloc(5000, 31));
  ok([200, 201].includes(sh3.status) && (await claimOf(T3)) === 0 && (await acctT3.budget()).claim === 0, "sharing at the edge: sync gives back its unused claim, and the upload goes (" + sh3.status + ")");
  // (fail closed: the give-back can't reach D1, so the refusal stands)
  const r3b = await acctT3.reserve({ account: T3, sha256: sha(Buffer.from("t3 slack 2")), size: 4900 });
  await acctT3.abandon({ id: r3b.ok.id });
  const held3 = await claimOf(T3);
  await acctT3.setFailClaim({ on: true });
  const sh3b = await sharePut(st3, Buffer.alloc(4900, 32));
  ok(sh3b.status === 413 && (await claimOf(T3)) === held3, "if sync's give-back can't reach D1, sharing's refusal stands: never fail open (" + sh3b.status + ", claim " + held3 + ")");
  await acctT3.setFailClaim({ on: false });
  ok(await until(async () => (await acctT3.budget()).dirty === false && (await claimOf(T3)) === (await acctT3.budget()).claim), "(the alarm writes the give-back D1 missed)");
  ok((await claimOf(T3)) + (await sharingOf(T3)) <= L, "and sharing + claim is within storage_bytes throughout");
  // T3: a lost answer's hold stays until its attempt can't commit, then the document's total replaces it
  const s3 = await socket(st3);
  await hello(s3, dev1);
  const lostT3 = await s3.ask(batch(LOSE, 1, [[1, pid(1, "clientT3LO"), [], "x".repeat(300)]], { kind: "board" }));
  const bh = await acctT3.budget();
  ok(lostT3?.code === "busy" && bh.holds === 1 && bh.held === 300, "a batch whose answer is lost keeps its 300 bytes held against the budget");
  ok(await until(async () => { const b = await acctT3.budget(); return b.holds === 0 && b.held === 0 && b.documents === 300; }), "once its attempt can no longer commit, the alarm asks the document: its total (300) replaces the hold");
  s3.ws.close();
  // T3: the purge gives the claim back
  ok((await del(st3, T3)).status === 202 && (await until(async () => (await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(T3)).first())?.state === "purged")), "(T3: Delete my synced data)");
  ok((await claimOf(T3)) === 0, "the purge sets the claim to 0, so the space is sharing's again");
  // T2: documents may take the claim past storage_bytes into the ceiling (max(L / 10, 256 in tests) = 1,000), no further
  const st2 = await signIn(T2);
  const acctT2 = acctNs.get(acctNs.idFromName("acct:" + hashOf(T2)));
  ok((await post(st2, "/api/sync/v1/enable", {})).status === 200, "(T2: sync on)");
  const s2 = await socket(st2);
  await hello(s2, dev1);
  const docT2 = "7272cafe7272";
  const codes = [];
  for (let i = 1; i <= 8; i++) {
    const a = await s2.ask(batch(docT2, 1, [[i, pid(i, "clientT2CE"), i > 1 ? [pid(i - 1, "clientT2CE")] : [], "d".repeat(1500)]], i === 1 ? { kind: "board" } : {}));
    codes.push(a?.batch?.new === 1 ? "ok" : a?.code);
  }
  const b2 = await acctT2.budget();
  const c2 = await claimOf(T2);
  ok(codes.slice(0, 7).every((c) => c === "ok") && codes[7] === "storage_full" && b2.documents === 10_500 && c2 > L && c2 <= L + 1000,
    "document batches go past storage_bytes into the ceiling (10,500 of 10,000 + 1,000), and the one past the ceiling is refused, storage_full: " + JSON.stringify({ codes, documents: b2.documents, claim: c2 }));
  const shIn = await sharePut(st2, Buffer.from("1"));
  const syIn = await put(st2, Buffer.from("1"));
  ok(shIn.status === 413 && syIn.status === 507, "with sync in the ceiling, sharing refuses even one byte (its check is already over, never wrapped), and so do sync's files: " + JSON.stringify([shIn.status, syIn.status]));
  // T2: a downgrade below what is held refuses growth and deletes nothing
  // (as CoCalc would: its limits answer and its notice both say 5,000)
  fake.limits.set(T2, sync(5000, 1 << 20));
  ok((await (await signedPost(LIMITS_KEY, "/api/admin/limits", JSON.stringify({ request_id: crypto.randomUUID(), account_id: T2, issued: Date.now(), limits: sync(5000, 1 << 20) }))).json()).applied === true, "(T2 downgraded to 5,000)");
  const after = await s2.ask(batch(docT2, 1, [[8, pid(8, "clientT2CE"), [pid(7, "clientT2CE")], "e"]]));
  const pulled = await s2.ask({ t: "pull", doc: docT2, epoch: 1, after: 0 });
  ok(after?.code === "storage_full" && (await acctT2.budget()).documents === 10_500 && (pulled?.items?.length ?? 0) > 0, "after the downgrade, a new batch is refused and nothing is deleted: the document still reads in full");
  s2.ws.close();
  // T4: D1 writes per growth: one raise per chunk (storage_bytes / 64), not one per edit
  const st4 = await signIn(T4);
  const acctT4 = acctNs.get(acctNs.idFromName("acct:" + hashOf(T4)));
  ok((await post(st4, "/api/sync/v1/enable", {})).status === 200, "(T4: sync on, storage_bytes 1 MiB, chunk 16,384)");
  const s4 = await socket(st4);
  await hello(s4, dev1);
  const docT4 = "7474cafe7474";
  for (let i = 1; i <= 20; i++) await s4.ask(batch(docT4, 1, [[i, pid(i, "clientT4WR"), i > 1 ? [pid(i - 1, "clientT4WR")] : [], "w".repeat(1000)]], i === 1 ? { kind: "board" } : {}));
  const b4 = await acctT4.budget();
  ok(b4.documents === 20_000 && b4.calls <= 3, "20 batches, 20,000 bytes: " + b4.calls + " D1 claim writes, one a chunk, not one an edit");
  s4.ws.close();
  // LIMIT-97A-1: production's chunk (4 MiB, so L itself), with less than a chunk left below the cap: the
  // tail is taken in one write, and a full budget is refused without a D1 call an edit
  const st5 = await signIn(T5);
  const acctT5 = acctNs.get(acctNs.idFromName("acct:" + hashOf(T5)));
  ok((await post(st5, "/api/sync/v1/enable", {})).status === 200, "(T5: sync on, storage_bytes 1 MiB)");
  await acctT5.setChunk({ bytes: 4 << 20 });
  ok([200, 201].includes((await sharePut(st5, Buffer.alloc(40_000, 51))).status), "(sharing holds 40,000 first: less than a chunk is left)");
  const s5 = await socket(st5);
  await hello(s5, dev1);
  const docT5 = "7575cafe7575";
  const c5 = [];
  for (let i = 1; i <= 14; i++) {
    const a = await s5.ask(batch(docT5, 1, [[i, pid(i, "clientT5TL"), i > 1 ? [pid(i - 1, "clientT5TL")] : [], "t".repeat(100_000)]], i === 1 ? { kind: "board" } : {}));
    c5.push(a?.batch?.new === 1 ? "ok" : a?.code);
    if (a?.batch?.new !== 1) break;
  }
  const calls5 = (await acctT5.budget()).calls;
  const more = [];
  const writes5 = (await acctT5.budget()).writes;
  // (each as large as the one refused: none fits)
  for (let i = 0; i < 6; i++) more.push((await s5.ask(batch(docT5, 1, [[1, pid(100 + i, `clientT5M${i}`), [], "v".repeat(100_000)]])))?.code ?? "ok");
  const b5 = await acctT5.budget();
  const c5d = await claimOf(T5);
  ok(c5.filter((c) => c === "ok").length >= 10 && c5.at(-1) === "storage_full" && writes5 === 2 && calls5 <= 5 && c5d + 40_000 <= (1 << 20) + Math.max(256, Math.floor((1 << 20) / 10)),
    "with production's chunk and less than one left, 11 edits: the tail below L and the ceiling's are one D1 write each (2), with " + calls5 + " statements in all: " + JSON.stringify({ batches: c5, writes: writes5, calls: calls5, claim: c5d }));
  ok(more.every((c) => c === "storage_full") && b5.calls - calls5 <= 2 && b5.writes === writes5, "and, full, 6 more edits are refused with at most 2 D1 statements (once refused, a while without asking), none a write: " + JSON.stringify({ more, calls: b5.calls - calls5 }));
  s5.ws.close();
  // LIMIT-97A-2: at most 200 open holds; a zero-byte batch takes one too
  const st6 = await signIn(T6);
  const acctT6 = acctNs.get(acctNs.idFromName("acct:" + hashOf(T6)));
  ok((await post(st6, "/api/sync/v1/enable", {})).status === 200, "(T6: sync on)");
  const s6 = await socket(st6);
  await hello(s6, dev1);
  const z1 = await s6.ask(batch(LOSE, 1, [[1, pid(1, "clientT6ZB"), [], ""]], { kind: "board" }));
  ok(z1?.code === "busy" && (await acctT6.budget()).holds === 1, "(a zero-byte batch whose answer is lost holds a row)");
  ok((await acctT6.seedHolds({ n: 198 })) === 199, "(199 open holds)");
  const z2 = await s6.ask(batch("7676cafe7676", 1, [[1, pid(2, "clientT6ZB"), [], ""]], { kind: "board" }));
  ok(z2?.batch?.new === 1 && (await acctT6.budget()).holds === 199, "the 200th, answered, goes, and its hold is gone at once");
  await acctT6.seedHolds({ n: 1 });
  const z3 = await s6.ask(batch("7777cafe7777", 1, [[1, pid(3, "clientT6ZB"), [], ""]], { kind: "board" }));
  ok(z3?.code === "busy" && (await acctT6.budget()).holds === 200, "with 200 open, a new batch is refused, busy with retry_after, and makes no row (LIMIT-97A-2)");
  s6.ws.close();
  // CORR-97A-1: a raise's D1 answer, held across a purge of its generation and a new one: never installed
  const gs = (name, on) => fetchAt(SITE, `/__test/gate?name=${name}&on=${on ? 1 : 0}`, { method: "POST" });
  const su1 = await signIn(U1);
  const acctU1 = acctNs.get(acctNs.idFromName("acct:" + hashOf(U1)));
  ok((await post(su1, "/api/sync/v1/enable", {})).status === 200, "(U1: sync on, generation 1)");
  await gs("claim-raise-answer", true);
  const pr1 = acctU1.reserve({ account: U1, sha256: sha(Buffer.from("u1 raise")), size: 5000 });
  ok(await until(async () => (await claimOf(U1)) >= 5000), "(the raise's statement ran in D1: 5,000 granted, its answer held)");
  ok((await del(su1, U1)).status === 202 && (await until(async () => (await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(U1)).first())?.state === "purged")), "(meanwhile, Delete my synced data: generation 1 purged, its claim 0)");
  const en2u = await (await post(su1, "/api/sync/v1/enable", {})).json();
  ok(en2u.generation === 2 && en2u.state === "active", "(sync on again: generation 2)");
  await gs("claim-raise-answer", false);
  const rr1 = await pr1;
  const bu1 = await acctU1.budget();
  ok(rr1?.error && bu1.claim === 0 && bu1.files === 0 && (await claimOf(U1)) === 0, "the old raise's answer, arriving now, is not installed in generation 2: no claim, no reservation (CORR-97A-1): " + JSON.stringify({ r: rr1, claim: bu1.claim, files: bu1.files }));
  // CORR-97A-2: a raise's answer held across a downgrade: the downgrade's zeroed caps stand
  const su2 = await signIn(U2);
  const acctU2 = acctNs.get(acctNs.idFromName("acct:" + hashOf(U2)));
  ok((await post(su2, "/api/sync/v1/enable", {})).status === 200, "(U2: sync on, storage_bytes 10,000)");
  await gs("claim-raise-answer", true);
  const pr2 = acctU2.reserve({ account: U2, sha256: sha(Buffer.from("u2 raise")), size: 5000 });
  ok(await until(async () => (await claimOf(U2)) >= 5000), "(the raise's statement ran: its answer held)");
  // (and a second upload's raise queued behind it, with the limit as it was when it asked)
  const pr2b = acctU2.reserve({ account: U2, sha256: sha(Buffer.from("u2 raise, queued")), size: 4000 });
  await new Promise((r) => setTimeout(r, 200));
  fake.limits.set(U2, sync(0, 1 << 20));
  ok((await (await signedPost(LIMITS_KEY, "/api/admin/limits", JSON.stringify({ request_id: crypto.randomUUID(), account_id: U2, issued: Date.now(), limits: sync(0, 1 << 20) }))).json()).applied === true, "(meanwhile, a downgrade to 0)");
  await gs("claim-raise-answer", false);
  const rr2 = await pr2;
  const rr2b = await pr2b;
  const bu2 = await acctU2.budget();
  ok(rr2b?.error !== undefined, "the raise queued behind it, run after the downgrade, reads the new limit, not the one it was queued with, and admits nothing: " + JSON.stringify(rr2b));
  ok(rr2?.error && bu2.blob_cap === 0 && bu2.files === 0 && (await put(su2, Buffer.from("u2 after"))).status !== 201, "the older raise's answer doesn't restore the caps the downgrade zeroed, and nothing is reserved or taken (CORR-97A-2): " + JSON.stringify({ r: rr2, blob_cap: bu2.blob_cap, files: bu2.files }));
  // CORR-97A-3: a batch refused before its forward (its blob was never uploaded) gives its hold back
  const su3 = await signIn(U3);
  const acctU3 = acctNs.get(acctNs.idFromName("acct:" + hashOf(U3)));
  ok((await post(su3, "/api/sync/v1/enable", {})).status === 200, "(U3: sync on)");
  const s3u = await socket(su3);
  await hello(s3u, dev1);
  const nb = await s3u.ask(batch("7979cafe7979", 1, [[1, pid(1, "clientU3NB"), [], "abc", [sha(Buffer.from("never uploaded"))]]], { kind: "board" }));
  const bu3 = await acctU3.budget();
  ok(nb?.code && nb.code !== "busy" && bu3.holds === 0 && bu3.held === 0, "a batch refused before its forward (a blob not uploaded) leaves no hold: " + JSON.stringify({ code: nb?.code, holds: bu3.holds, held: bu3.held }));
  s3u.ws.close();
  // CORR-BDA-1: a raise D1 granted, answered after a downgrade: no caps, and the grant is given back by
  // the alarm alone, even with the first give-back failing
  const sv1 = await signIn(V1);
  const acctV1 = acctNs.get(acctNs.idFromName("acct:" + hashOf(V1)));
  ok((await post(sv1, "/api/sync/v1/enable", {})).status === 200, "(V1: sync on, empty, storage_bytes 10,000)");
  await gs("claim-raise-answer", true);
  const prv = acctV1.reserve({ account: V1, sha256: sha(Buffer.from("v1 raise")), size: 5000 });
  ok(await until(async () => (await claimOf(V1)) >= 5000), "(the raise's statement ran in D1: its answer held)");
  fake.limits.set(V1, sync(0, 1 << 20));
  ok((await (await signedPost(LIMITS_KEY, "/api/admin/limits", JSON.stringify({ request_id: crypto.randomUUID(), account_id: V1, issued: Date.now(), limits: sync(0, 1 << 20) }))).json()).applied === true, "(meanwhile, a downgrade to 0)");
  await acctV1.setFailClaim({ on: true });
  await gs("claim-raise-answer", false);
  const rv = await prv;
  const bv = await acctV1.budget();
  ok(rv?.error && bv.blob_cap === 0 && bv.files === 0 && bv.alarm !== null, "the grant arrives after the downgrade: no caps, nothing reserved, and the alarm is armed for it: " + JSON.stringify({ r: rv?.error?.code, claim: bv.claim, alarm: bv.alarm !== null }));
  await new Promise((r) => setTimeout(r, 800));
  const bv2 = await acctV1.budget();
  ok((await claimOf(V1)) >= 5000 && bv2.alarm !== null && bv2.dirty === true, "while the give-back can't reach D1, it is retried from the alarm, which stays armed: D1 still holds the grant");
  await acctV1.setFailClaim({ on: false });
  ok(await until(async () => (await claimOf(V1)) <= 1 && (await acctV1.budget()).claim <= 1 && (await acctV1.budget()).dirty === false), "with no further request, the alarm gives the unusable grant back, in D1 too (CORR-BDA-1): " + (await claimOf(V1)));
  // (and a lower limit alone: slack within 2 chunks of the old one, beyond 2 of the new, is given back)
  fake.limits.set(V1, sync(10_000, 1 << 20));
  await signedPost(LIMITS_KEY, "/api/admin/limits", JSON.stringify({ request_id: crypto.randomUUID(), account_id: V1, issued: Date.now(), limits: sync(10_000, 1 << 20) }));
  const rv2 = await acctV1.reserve({ account: V1, sha256: sha(Buffer.from("v1 small")), size: 100 });
  await acctV1.abandon({ id: rv2.ok.id });
  // (until no alarm is pending at all: the upload's own end has passed, so only the notice can arm one)
  ok(await until(async () => (await acctV1.budget()).alarm === null, 10_000), "(nothing pending: no alarm)");
  const slack = await claimOf(V1);
  ok(rv2?.ok?.id && slack >= 100 && slack <= 2 * 156, "(an unused claim of " + slack + ", within 2 chunks of 10,000: kept)");
  fake.limits.set(V1, sync(1000, 1 << 20));
  await signedPost(LIMITS_KEY, "/api/admin/limits", JSON.stringify({ request_id: crypto.randomUUID(), account_id: V1, issued: Date.now() + 1, limits: sync(1000, 1 << 20) }));
  ok(await until(async () => (await claimOf(V1)) <= 64), "a notice lowering the limit to 1,000 (chunk 64) has the alarm give back what is beyond 2 chunks of it, with no further request: " + (await claimOf(V1)));
  // (the cache's refusal says it is temporary)
  const full1 = await s3u_full_probe();
  async function s3u_full_probe() {
    const sx = await signIn(T5);
    const so = await socket(sx);
    await hello(so, dev2);
    const a = await so.ask(batch("7575cafe7575", 1, [[1, pid(300, "clientT5RA"), [], "w".repeat(100_000)]]));
    const b = await so.ask(batch("7575cafe7575", 1, [[1, pid(301, "clientT5RB"), [], "w".repeat(100_000)]]));
    so.ws.close();
    return [a, b];
  }
  ok(full1[1]?.code === "storage_full" && Number(full1[1]?.detail?.retry_after) > 0, "a refusal from the full cache is storage_full with retry_after, the time left: try again shortly: " + JSON.stringify(full1[1]?.detail));
  // the breakdown: sharing's files and versions, sync's files and documents, against the one storage_bytes
  const me = await (await fetchAt(SITE, "/api/share/me", { headers: { cookie: st2 } })).json();
  ok(me.usage_breakdown?.sync_documents === 10_500 && me.usage_breakdown.sync_files === 0 && me.usage_breakdown.sharing_files === 0 && me.usage === 10_500, "the usage breakdown shows each part, sync's documents on their own line, and their sum: " + JSON.stringify({ usage: me.usage, parts: me.usage_breakdown }));
}

// ---- after a membership ends (§6.2): read-only, then the purge at sync.retention_days, unless renewed
{
  const notice = (account, enabled, issued) => signedPost(LIMITS_KEY, "/api/admin/limits", JSON.stringify({ request_id: crypto.randomUUID(), account_id: account, issued, limits: plan(enabled) }));
  const retentionOf = async (account) => { const r = await signedGet(LIMITS_KEY, `/api/admin/sync-retention/${account}`); return [r.status, await r.json()]; };
  const rowState = async (id) => (await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(id)).first())?.state;
  const bkt = await mf.getR2Bucket("SHARE_BUCKET", "sync");
  const docNs = await mf.getDurableObjectNamespace("SYNC_DOC", "sync");
  // R1: lapse, then renew inside the window: read-only meanwhile, no purge
  const sr1 = await signIn(R1);
  ok((await post(sr1, "/api/sync/v1/enable", {})).status === 200 && (await put(sr1, Buffer.from("R1's file"))).status === 201, "(R1: on, with a file)");
  const t1 = Date.now();
  ok((await (await notice(R1, false, t1)).json()).applied === true, "(R1's membership ends: a notice, sync off)");
  const [g1, b1] = await retentionOf(R1);
  ok(g1 === 200 && b1.state === "readonly" && b1.readonly_since === t1 && b1.purge_after === t1 + 3000, "the account is read-only, its clock started at the notice's issue time, the deletion due retention_days later: " + JSON.stringify(b1));
  const x1 = await socket(sr1);
  await hello(x1, dev1);
  const rb = await x1.ask(batch("5151aaaa5151", 1, [[1, pid(1, "clientR1RO"), [], "edit"]], { kind: "board" }));
  const ru = await put(sr1, Buffer.from("R1, read-only"));
  ok(rb?.code === "readonly" && ru.status === 409, "every write is refused, readonly: a batch and an upload (" + rb?.code + ", " + ru.status + ")");
  const me1 = await (await fetchAt(SITE, "/api/share/me", { headers: { cookie: sr1 } })).json();
  ok(me1.sync_retention?.purge_after === t1 + 3000, "and /me says when the synced data will be deleted");
  fake.limits.set(R1, plan(true));
  ok((await (await notice(R1, true, t1 + 1)).json()).applied === true, "(R1 renews, inside the window)");
  const [, b1b] = await retentionOf(R1);
  ok(b1b.state === "active" && b1b.readonly_since === null && b1b.purge_after === null && (await put(sr1, Buffer.from("R1, renewed"))).status === 201, "renewed inside the window: the clock ends, and writes go again");
  await new Promise((r) => setTimeout(r, 3500));
  ok((await acctNs.get(acctNs.idFromName("acct:" + hashOf(R1))).lifecycle())?.state === "active" && (await rowState(R1)) === "active", "past the old deadline, nothing was deleted");
  x1.ws.close();
  // R2: lapse past the window: the same purge as Delete my synced data
  const sr2 = await signIn(R2);
  ok((await post(sr2, "/api/sync/v1/enable", {})).status === 200 && (await put(sr2, Buffer.from("R2's file"))).status === 201, "(R2: on, with a file)");
  fake.limits.set(R2, plan(false));
  ok((await (await notice(R2, false, Date.now())).json()).applied === true, "(R2's membership ends)");
  ok(await until(async () => (await rowState(R2)) === "purged", 10_000), "past retention_days, the account object deletes its synced data, as Delete my synced data does");
  ok((await bkt.list({ prefix: `s/${hashOf(R2).slice(0, 32)}/` })).objects.length === 0 && (await acctNs.get(acctNs.idFromName("acct:" + hashOf(R2))).lifecycle())?.state === null, "nothing of R2's is left in R2, and its account object is a tombstone");
  // R3: repeated and late notices neither reset the clock nor end it
  const sr3 = await signIn(R3);
  ok((await post(sr3, "/api/sync/v1/enable", {})).status === 200, "(R3: on)");
  const t3 = Date.now();
  await notice(R3, false, t3);
  const again = await (await notice(R3, false, t3 + 500)).json();
  const [, b3] = await retentionOf(R3);
  ok(again.applied === true && b3.readonly_since === t3 && b3.purge_after === t3 + 3000, "a repeated notice, newer, doesn't reset the clock: readonly_since stays the first");
  const late = await (await notice(R3, true, t3 - 1000)).json();
  const [, b3b] = await retentionOf(R3);
  ok(late.applied === false && b3b.state === "readonly" && b3b.readonly_since === t3, "a late notice (issued before the lapse) saying sync is back is not applied: still read-only, the same clock");
  // R4: the clock at the boundary
  const sr4 = await signIn(R4);
  const acctR4 = acctNs.get(acctNs.idFromName("acct:" + hashOf(R4)));
  ok((await post(sr4, "/api/sync/v1/enable", {})).status === 200, "(R4: on)");
  const t4 = Date.now();
  await notice(R4, false, t4);
  // (the purge runs at the deadline plus a delay of 0 to an hour, a 24th of a day, fixed per account: never before)
  const pat = await acctR4.retentionPurgeAt();
  const [, b4] = await retentionOf(R4);
  ok(b4.purge_after === t4 + 3000 && pat >= b4.purge_after && pat < b4.purge_after + 1000 / 24, "the purge time is the deadline plus this account's delay, within an hour after it, never before; purge_after stays the deadline: " + JSON.stringify({ deadline: b4.purge_after, purge_at: pat }));
  const atDeadline = await acctR4.retainAt({ at: b4.purge_after - 1 });
  const before = await acctR4.retainAt({ at: pat - 1 });
  ok(atDeadline === "keep" && before === "keep" && (await acctR4.lifecycle())?.state === "readonly", "before the deadline, and one millisecond before the purge time: kept, read-only");
  const at = await acctR4.retainAt({ at: pat });
  ok(at === "purge" && (await until(async () => (await acctR4.lifecycle())?.state !== "readonly")), "at the purge time exactly: the purge starts");
  // LIMIT-445-1: a purge step takes at most 200 expired reservations; the purge still finishes
  const sw1 = await signIn(W1);
  const acctW1 = acctNs.get(acctNs.idFromName("acct:" + hashOf(W1)));
  ok((await post(sw1, "/api/sync/v1/enable", {})).status === 200, "(W1: on)");
  ok((await acctW1.seedReservations({ n: 450 })) === 450, "(450 expired reservations, as if their uploads died and no alarm tidied them)");
  await acctW1.holdPurge({ on: true });
  ok((await del(sw1, W1)).status === 202, "(W1: Delete my synced data, its steps held)");
  const steps = [];
  for (let i = 0; i < 4; i++) steps.push((await acctW1.purgeStepOnce())?.reservations);
  ok(steps[0] === 250 && steps[1] === 50 && steps[2] === 0, "each purge step takes at most 200 of them: " + JSON.stringify(steps));
  await acctW1.holdPurge({ on: false });
  ok(await until(async () => (await rowState(W1)) === "purged"), "and the purge finishes");
  // (pacing, daybreak2: a full page goes on after 250 ms at the least, so at most 4 steps a second)
  const sw2 = await signIn(W2);
  const acctW2 = acctNs.get(acctNs.idFromName("acct:" + hashOf(W2)));
  ok((await post(sw2, "/api/sync/v1/enable", {})).status === 200 && (await acctW2.seedReservations({ n: 900 })) === 900, "(W2: on, 900 expired reservations)");
  ok((await del(sw2, W2)).status === 202 && (await until(async () => (await rowState(W2)) === "purged", 15_000)), "(W2: Delete my synced data, run by the alarm alone, finishes)");
  const tw = await acctW2.purgeStepTimes();
  const gaps = tw.slice(1).map((t, i) => t - tw[i]);
  ok(tw.length >= 5 && gaps.slice(0, 4).every((g) => g >= 250), "each step after a full page waits 250 ms at the least: " + JSON.stringify(gaps.slice(0, 6)));
  // CORR-445-1: the deadline is fixed when the lapse is recorded; a renewal with a longer, or no, period can't move it
  const lapseThen = async (id, renew, at) => {
    const se = await signIn(id);
    const a = acctNs.get(acctNs.idFromName("acct:" + hashOf(id)));
    ok((await post(se, "/api/sync/v1/enable", {})).status === 200, `(${id.slice(0, 2)}: on)`);
    const t = Date.now();
    const lapsed = await a.planAt({ limits: plan(false, 100), issued: t, now: t });
    const r = await a.planAt({ limits: renew, issued: t + 1, now: lapsed.purge_after + at });
    return [lapsed, r];
  };
  const omitted = (() => { const p = plan(true, 90); delete p.sync.retention_days; return p; })();
  const [y1a, y1b] = await lapseThen(Y1, plan(true, 90), -1);
  ok(y1b.state === "active" && y1b.purge_after === null, "renewed 1 ms before the deadline: the clock ends");
  const [y2a, y2b] = await lapseThen(Y2, omitted, 0);
  ok(y2b.state === "readonly" && y2b.purge_after === y2a.purge_after, "renewed at the deadline exactly, its period omitted: the purge stands, the deadline unmoved (CORR-445-1)");
  const [y3a, y3b] = await lapseThen(Y3, plan(true, 90), 1);
  ok(y3b.state === "readonly" && y3b.purge_after === y3a.purge_after, "renewed 1 ms after it, with a longer period: the purge stands, the deadline unmoved");
  // the clock rule: max(issued + retention_days, received + 14 days); a late notice never deletes without warning
  const sy4 = await signIn(Y4);
  ok((await post(sy4, "/api/sync/v1/enable", {})).status === 200, "(Y4: on)");
  const recv = Date.now();
  await notice(Y4, false, recv - 100 * 1000);
  const [, b4b] = await retentionOf(Y4);
  ok(b4b.state === "readonly" && b4b.readonly_since === recv - 100 * 1000 && b4b.purge_after >= recv + 1000 && b4b.purge_after < recv + 1000 + 2000, "a notice issued 100 days ago: the clock starts then, but the purge is no sooner than the floor after it arrived (14 days; 1 in tests): " + JSON.stringify(b4b));
  // CORR-445-2: the plan is read before sync admits any write
  // and a plan without sync from the start isn't turned on at all: enable says so, and nothing is made
  const sx1 = await signIn(X1);
  const rx1 = await post(sx1, "/api/sync/v1/enable", {});
  const ex1 = await rx1.json();
  const acctX1 = acctNs.get(acctNs.idFromName("acct:" + hashOf(X1)));
  const ox1 = await socket(sx1);
  const hx1 = ox1.status === 101 ? await hello(ox1, dev1) : null;
  ok(rx1.status === 403 && ex1.message === "sync isn't available for this account" && (await acctX1.lifecycle())?.state === null && (await db.prepare("SELECT 1 AS x FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(X1)).first()) === null && hx1?.welcome?.t !== "welcome",
    "a plan without sync from the start: enable says sync isn't available for this account, and registers nothing; no socket session is welcomed: " + JSON.stringify([rx1.status, ex1, hx1?.welcome]));
  if (ox1.status === 101) ox1.ws.close();
  const sx2 = await signIn(X2);
  const acctX2 = acctNs.get(acctNs.idFromName("acct:" + hashOf(X2)));
  ok((await (await post(sx2, "/api/sync/v1/enable", {})).json()).state === "active", "(X2: on)");
  fake.limits.set(X2, plan(false));
  await new Promise((r) => setTimeout(r, 1100)); // (its cached plan grows old: the next write that needs room fetches it)
  const ox2 = await socket(sx2);
  await hello(ox2, dev1);
  const docX2 = "8282cafe8282";
  const bx2 = await ox2.ask(batch(docX2, 1, [[1, pid(1, "clientX2RO"), [], "abc"]], { kind: "board" }));
  const ix2 = await docNs.get(docNs.idFromName(`doc:${hashOf(X2)}:${docX2}`)).info();
  const bgx2 = await acctX2.budget();
  ok(bx2?.code === "readonly" && ix2.head.seq === 0 && ix2.total === 0 && bgx2.holds === 0 && bgx2.held === 0, "a plan that ended since: the first batch fetches it, is refused readonly, and commits nothing, holding nothing: " + JSON.stringify({ code: bx2?.code, head: ix2.head, holds: bgx2.holds }));
  ox2.ws.close();
  // an account already on asks its plan again when enable is sent: read-only now, it says so, never "active"
  const ex2 = await post(sx2, "/api/sync/v1/enable", {});
  const ex2b = await ex2.json();
  ok(ex2.status === 200 && ex2b.state === "readonly", "enable on an account whose plan ended answers readonly, not active: " + JSON.stringify(ex2b));
  // (its status now, before its retention can purge it: 3 "days", 3 s in tests, so a later check races the purge)
  const stx2 = await (await fetchAt(SITE, "/api/sync/v1/status", { headers: { cookie: sx2, "sec-fetch-site": "same-origin" } })).json();
  ok(stx2.available === true && stx2.state === "readonly", "GET /status: an account whose plan ended: readonly: " + JSON.stringify(stx2));
  // CORR-AB4-1: a lapse while a raise's grant is on its way back (storage_bytes unchanged): the upload is
  // refused readonly, and the grant is given back by the alarm, with no further request
  const sz1 = await signIn(Z1);
  const acctZ1 = acctNs.get(acctNs.idFromName("acct:" + hashOf(Z1)));
  ok((await post(sz1, "/api/sync/v1/enable", {})).status === 200, "(Z1: on, storage_bytes 1 MiB, retention 100 days)");
  const gz = (name, on) => fetchAt(SITE, `/__test/gate?name=${name}&on=${on ? 1 : 0}`, { method: "POST" });
  await gz("claim-raise-answer", true);
  const prz = acctZ1.reserve({ account: Z1, sha256: sha(Buffer.from("z1 raise")), size: 40_000 });
  ok(await until(async () => ((await db.prepare("SELECT claim_bytes FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(Z1)).first())?.claim_bytes ?? 0) >= 40_000), "(the raise's statement ran in D1: its answer held)");
  fake.limits.set(Z1, plan(false, 100));
  // (a 100-day retention: its deadline's alarm is far off, so only the grant's own can give it back soon)
  ok((await (await signedPost(LIMITS_KEY, "/api/admin/limits", JSON.stringify({ request_id: crypto.randomUUID(), account_id: Z1, issued: Date.now(), limits: plan(false, 100) }))).json()).applied === true, "(meanwhile, the membership ends: sync off, storage_bytes unchanged)");
  await gz("claim-raise-answer", false);
  const rz = await prz;
  const bz = await acctZ1.budget();
  ok(rz?.error?.code === "readonly" && bz.files === 0 && bz.alarm !== null && bz.alarm < Date.now() + 60_000, "the upload is refused readonly, nothing reserved, and the alarm is armed for the unused grant, not the deadline 100 days away: " + JSON.stringify({ r: rz?.error?.code, claim: bz.claim, alarm_in: bz.alarm - Date.now() }));
  ok(await until(async () => ((await db.prepare("SELECT claim_bytes FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(Z1)).first())?.claim_bytes ?? 0) <= 16_384), "with no further request, the alarm gives the grant back, to at most a chunk (CORR-AB4-1)");
  const [g5, b5] = await retentionOf(crypto.randomUUID());
  ok(g5 === 404, "CoCalc asking about an account that never synced: 404");
}

// ---- an op may name the folder it puts something in by its fid, `parent` (§3): checked for its form only,
// stored, and echoed; the reducer decides what it means
{
  const sp = await signIn(P1);
  ok((await post(sp, "/api/sync/v1/enable", {})).status === 200, "(P1: on)");
  const acctP = () => acctNs.get(acctNs.idFromName("acct:" + hashOf(P1)));
  const s = await socket(sp);
  await hello(s, "device-parent-01");
  const F1 = "aaaaaaaaaaaaaaaa", F2 = "bbbbbbbbbbbbbbbb", nbP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const op = (dseq, o) => ({ dseq, t: 1000 + dseq, by: "person", ...o });
  let a = await s.ask({ t: "ops", ops: [
    op(1, { op: "mkdir", path: "/F1", kind: "folder", fid: F1 }),
    op(2, { op: "mkdir", path: "/F1/F2", kind: "folder", fid: F2, parent: F1 }),
    op(3, { op: "create", path: "/F1/F2/n.ipynb", kind: "notebook", ref: nbP, parent: F2 }),
    op(4, { op: "rename", path: "/F1/F2/n.ipynb", to: "/F1/n.ipynb", kind: "notebook", ref: nbP, parent: F1 }),
    op(5, { op: "duplicate", path: "/F1/n.ipynb", to: "/F1/F2/m.ipynb", kind: "notebook", ref: nbP, parent: F2 }),
    op(6, { op: "restore", path: "/F1/F2", kind: "folder", fid: F2, parent: F1 }),
    op(7, { op: "adopt", path: "/F1/x", kind: "folder", parent: F1 }),
  ] });
  ok(a?.t === "ack" && a.ops.length === 7 && a.ops.every((o) => o.seq), "parent is accepted on mkdir, create, rename (the destination's), duplicate, restore and adopt: " + JSON.stringify(a?.ops));
  a = await s.ask({ t: "ops", ops: [
    op(8, { op: "remove", path: "/F1/x", kind: "folder", parent: F1 }),
    op(9, { op: "forget", path: "/F1/x", kind: "folder", parent: F1 }),
    op(10, { op: "dropVersions", path: "/F1/n.ipynb", kind: "notebook", ref: nbP, parent: F1 }),
    op(11, { op: "mkdir", path: "/F3", kind: "folder", parent: "AAAAAAAAAAAAAAAA" }),
    op(12, { op: "mkdir", path: "/F3", kind: "folder", parent: "aaaaaaaaaaaaaaa" }),
    op(13, { op: "mkdir", path: "/F3", kind: "folder", parent: 7 }),
    op(14, { op: "mkdir", path: "/F3", kind: "folder", parent: "ffffffffffffffff" }),
  ] });
  ok(a?.ops?.slice(0, 6).every((o) => o.code === "invalid") && a.ops[6].seq, "and refused on remove, forget and dropVersions, or when it isn't 16 lowercase hex; a parent the index doesn't have is still accepted (not checked here): " + JSON.stringify(a?.ops));
  const ix = await s.ask({ t: "pull_index", after: 0 });
  const parents = ix?.ops?.map((o) => o.parent ?? null);
  ok(JSON.stringify(parents) === JSON.stringify([null, F1, F2, F1, F2, F1, F1, "ffffffffffffffff"]), "the index echoes each op's parent, and leaves it out where there is none: " + JSON.stringify(parents));
  s.ws.close();
  // an object made before `parent`: its restart adds the column; its old ops come back without it, new ones carry it
  await acctP().testOldOps();
  await acctP().crash().catch(() => {});
  await until(async () => (await acctP().inspect({}).catch(() => null)) !== null, 10_000);
  const s2 = await socket(sp);
  const { welcome } = await hello(s2, "device-parent-01");
  const a2 = await s2.ask({ t: "ops", ops: [op(welcome.next_dseq, { op: "mkdir", path: "/F4", kind: "folder", parent: F1 })] });
  const ix2 = await s2.ask({ t: "pull_index", after: 0 });
  ok(a2?.ops?.[0]?.seq && ix2?.ops?.length === 9 && ix2.ops.slice(0, 8).every((o) => o.parent === undefined) && ix2.ops[8].parent === F1,
    "an object whose ops table predates parent gains the column on restart: old ops come back without it, a new op carries it: " + JSON.stringify(ix2?.ops?.map((o) => o.parent ?? null)));
  s2.ws.close();
}

// ---- the client's side of the contract: ops made by the client's own outbox (web/workspace/sync-outbox.ts
// wireOf, as step 2b-2 will send them), `parent` and all, are taken by this server (the case that would break
// 2b-2 if the field were refused).  The client sets parent only where the op's result is in a folder
// (api.ts log(): never on a remove into Trash, or a forget)
{
  const sp = await signIn(P2);
  ok((await post(sp, "/api/sync/v1/enable", {})).status === 200, "(P2: on)");
  const bytes = Buffer.from("a data file the client syncs"), bytes2 = Buffer.from("its next version");
  ok((await put(sp, bytes)).status === 201 && (await put(sp, bytes2)).status === 201, "(P2's two versions uploaded)");
  const W = "1111111111111111", X = "2222222222222222", Fd = "3333333333333333", nb = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const local = [
    { op: "mkdir", path: "/W", kind: "folder", fid: W },
    { op: "mkdir", path: "/W/X", kind: "folder", fid: X, parent: W },
    { op: "create", path: "/W/X/n.ipynb", kind: "notebook", ref: nb, parent: X },
    { op: "rename", path: "/W/X/n.ipynb", to: "/W/n.ipynb", kind: "notebook", ref: nb, parent: W },
    { op: "restore", path: "/W/X", kind: "folder", fid: X, parent: W },
    { op: "adopt", path: "/W/old", kind: "folder", fid: "4444444444444444", parent: W },
    { op: "create", path: "/W/X/d.csv", kind: "file", fid: Fd, sha256: sha(bytes), size: bytes.length, parent: X },
    { op: "write", path: "/W/X/d.csv", kind: "file", fid: Fd, sha256: sha(bytes2), size: bytes2.length, base: sha(bytes), parent: X },
    // (a remove and a restore say where: into Trash, and back; the client's log has `to` on both, as the reducer does)
    { op: "remove", path: "/W/X/d.csv", to: "/Trash/d.csv", kind: "file", fid: Fd, sha256: sha(bytes2), size: bytes2.length },
    { op: "restore", path: "/Trash/d.csv", to: "/W/X/d.csv", kind: "file", fid: Fd, sha256: sha(bytes2), size: bytes2.length, parent: X },
  ];
  const code = `import { wireOf } from ${JSON.stringify(join(here, "../workspace/sync-outbox.ts"))};
const local = ${JSON.stringify(local)};
console.log(JSON.stringify(local.map((o, i) => wireOf({ ...o, t: 7, by: "person", device: "d", after: {} }, i + 1))));`;
  const wire = JSON.parse(execFileSync("bun", ["-e", code], { encoding: "utf8" }));
  ok(wire.length === local.length && wire.every((w, i) => w && w.parent === local[i].parent && w.to === local[i].to), "(the client's wireOf keeps each op's parent: " + JSON.stringify(wire.map((w) => w?.parent ?? null)) + ")");
  const s = await socket(sp);
  await hello(s, "device-wire-0002");
  const a = await s.ask({ t: "ops", ops: wire });
  ok(a?.t === "ack" && a.ops.length === local.length && a.ops.every((o) => o.seq && !o.code), "the server takes the client's own wire ops with parent: mkdir, create, rename, restore, adopt, a data file's create and write, and a remove and restore saying `to`: " + JSON.stringify(a?.ops));
  const ix = await s.ask({ t: "pull_index", after: 0 });
  ok(JSON.stringify(ix?.ops?.map((o) => o.parent ?? null)) === JSON.stringify(local.map((o) => o.parent ?? null)), "and gives each one's parent back in the index");
  ok(JSON.stringify(ix?.ops?.map((o) => o.to ?? null)) === JSON.stringify(local.map((o) => o.to ?? null)), "and each one's `to`");
  const bad = await s.ask({ t: "ops", ops: [{ dseq: local.length + 1, t: 7, by: "person", op: "mkdir", path: "/Z", to: "/Y", kind: "folder", fid: "5555555555555555" }] });
  ok(bad?.ops?.[0]?.code === "invalid", "`to` on another op (mkdir) is still refused: " + JSON.stringify(bad?.ops));
  s.ws.close();
  // (the client's binding, CORR-PR58-1: hello and blob requests name the account hash and generation they are for;
  // a session of another account, or another generation, is refused before anything is sent or stored)
  const mine = sha("sagebrush-account\n" + P2), other = sha("sagebrush-account\n" + P1);
  const sb = await socket(sp);
  sb.send({ t: "hello", v: 2, device: "device-bind-0001", name: "t", index_after: 0, account: other, generation: 1 });
  const refusedHello = await sb.next((m) => m.t === "welcome" || m.t === "error");
  ok(refusedHello?.t === "error" && refusedHello.code === "forbidden" && refusedHello.detail?.reason === "account", "hello bound to another account's hash: refused, no welcome: " + JSON.stringify(refusedHello));
  sb.send({ t: "hello", v: 2, device: "device-bind-0001", name: "t", index_after: 0, account: mine, generation: 2 });
  const refusedGen = await sb.next((m) => m.t === "welcome" || m.t === "error");
  ok(refusedGen?.t === "error" && refusedGen.code === "conflict" && refusedGen.detail?.reason === "generation", "hello bound to another generation: refused: " + JSON.stringify(refusedGen));
  sb.send({ t: "hello", v: 2, device: "device-bind-0001", name: "t", index_after: 0, account: mine, generation: 1 });
  ok((await sb.next((m) => m.t === "welcome" || m.t === "error"))?.t === "welcome", "hello bound to its own account and generation: welcome");
  sb.ws.close();
  const bytes3 = Buffer.from("bound bytes");
  const checkAs = (h) => fetchAt(SITE, "/api/sync/v1/blobs/check", { method: "POST", headers: { cookie: sp, origin: SITE, "content-type": "application/json", ...h }, body: JSON.stringify({ blobs: [{ sha256: sha(bytes3), size: bytes3.length }] }) });
  const putAs = (h) => fetchAt(SITE, `/api/sync/v1/blob/${sha(bytes3)}`, { method: "PUT", headers: { cookie: sp, origin: SITE, "content-type": "application/octet-stream", ...h }, body: bytes3 });
  ok((await checkAs({ "x-sync-account": other })).status === 403 && (await checkAs({ "x-sync-account": mine, "x-sync-generation": "2" })).status === 409 && (await checkAs({ "x-sync-account": mine, "x-sync-generation": "1" })).status === 200, "blobs/check bound: another account 403, another generation 409, its own 200");
  ok((await putAs({ "x-sync-account": other })).status === 403 && (await putAs({ "x-sync-account": mine, "x-sync-generation": "2" })).status === 409, "PUT bound to another account or generation: refused");
  const still = await (await checkAs({ "x-sync-account": mine, "x-sync-generation": "1" })).json();
  ok(still.missing?.includes(sha(bytes3)), "…and nothing stored by them");
  ok((await putAs({ "x-sync-account": mine, "x-sync-generation": "1" })).status === 201, "PUT bound to its own: stored");
}

// ---- the page's question: GET /api/sync/v1/status, which never creates or registers anything
{
  const status = async (session) => {
    const r = await fetchAt(SITE, "/api/sync/v1/status", { headers: { cookie: session, "sec-fetch-site": "same-origin" } });
    return [r.status, await r.json()];
  };
  const nothing = async (id) => (await acctNs.get(acctNs.idFromName("acct:" + hashOf(id))).lifecycle())?.state === null && (await db.prepare("SELECT 1 AS x FROM sync_accounts WHERE account_hash = ?1").bind(hashOf(id)).first()) === null;
  const s1 = await signIn(ST1);
  let [c, b] = await status(s1);
  ok(c === 200 && b.available === true && b.state === "off" && b.generation === undefined && b.reason === undefined && (await nothing(ST1)), "status of an account never synced, whose plan has sync: available, off, and nothing is made: " + JSON.stringify(b));
  // (the account echo, PR #130: the hash of this request's own session, whatever the caller sends)
  ok(b.account === hashOf(ST1), "status says which account it was computed for: this session's account hash: " + JSON.stringify(b.account));
  {
    const r = await fetchAt(SITE, "/api/sync/v1/status?account=" + hashOf(ST2), { headers: { cookie: s1, "sec-fetch-site": "same-origin", "x-account": hashOf(ST2) } });
    const bb = await r.json();
    ok(bb.account === hashOf(ST1), "…from the session alone: an account named in the query or a header changes nothing: " + JSON.stringify(bb.account));
  }
  for (let i = 0; i < 5; i++) await status(s1);
  await new Promise((r) => setTimeout(r, 1100)); // (past the object's minute, a second in tests: it asks CoCalc again)
  [c, b] = await status(s1);
  ok(b.available === true && (await nothing(ST1)), "asked again and again, before and after the plan it remembers grows old: still nothing is made");
  const s2 = await signIn(ST2);
  [c, b] = await status(s2);
  ok(c === 200 && b.available === false && b.reason === "not_allowlisted" && b.state === "off" && b.account === hashOf(ST2) && (await nothing(ST2)), "off the allowlist: not available, not_allowlisted (for the page's logic: it hides the switch), its account echoed");
  const sx = await signIn(X1);
  [c, b] = await status(sx);
  ok(b.available === false && b.reason === "plan_has_no_sync" && b.state === "off" && (await nothing(X1)), "a plan without sync: plan_has_no_sync, nothing made: " + JSON.stringify(b));
  fake.down = true;
  const s4 = await signIn(ST4);
  [c, b] = await status(s4);
  fake.down = false;
  ok(b.available === false && b.reason === "cocalc_unreachable" && b.retry_after === 5000 && b.state === "off" && (await nothing(ST4)), "CoCalc down: cocalc_unreachable, with retry_after, nothing made: " + JSON.stringify(b));
  await new Promise((r) => setTimeout(r, 600));
  [c, b] = await status(s4);
  ok(b.available === true, "and once CoCalc answers, after the moment it isn't asked: available");
  [c, b] = await status(sa);
  ok(b.available === true && b.state === "active" && b.generation === (await genOf(A)) && b.account === hashOf(A), "an account on: its state and generation, its account echoed: " + JSON.stringify(b));
  // beside an enable: the statuses are answered from whatever is so, and the one enable registers once
  const s3 = await signIn(ST3);
  const [en, ...st] = await Promise.all([post(s3, "/api/sync/v1/enable", {}), status(s3), status(s3), status(s3), status(s3)]);
  const enb = await en.json();
  const [, after] = await status(s3);
  ok(en.status === 200 && enb.state === "active" && enb.generation === 1 && st.every(([c2, b2]) => c2 === 200 && b2.available === true && ["off", "registering", "active"].includes(b2.state)) && after.state === "active" && after.generation === 1 && (await genOf(ST3)) === 1,
    "statuses beside an enable: each answers off, registering or active, the enable registers generation 1 once, and status then says active 1: " + JSON.stringify({ enb, st: st.map(([, x]) => x.state), after }));
  // LIMIT-SYNC-STATUS-1: cold, at once, four statuses and an enable make one CoCalc request between them
  const s5 = await signIn(ST5);
  let open5;
  fake.limitsGate = new Promise((r) => (open5 = r));
  const cold = Promise.all([status(s5), status(s5), post(s5, "/api/sync/v1/enable", {}).then(async (r) => [r.status, await r.json()]), status(s5), status(s5)]);
  await until(async () => (fake.calls.get(ST5) ?? 0) >= 1, 5000);
  await new Promise((r) => setTimeout(r, 300)); // (the rest arrive while the one request waits)
  open5();
  fake.limitsGate = null;
  const coldRes = await cold;
  ok(fake.calls.get(ST5) === 1 && coldRes[2][0] === 200 && coldRes[2][1].state === "active" && coldRes.every(([c5]) => c5 === 200),
    "cold statuses and an enable at once: one CoCalc request between them, and the enable turns sync on: " + JSON.stringify({ calls: fake.calls.get(ST5), res: coldRes.map(([, x]) => x.state ?? x) }));
  // polled through an outage: one CoCalc request per retry gate, not one per poll; an enable meanwhile asks none either
  fake.down = true;
  const s6 = await signIn(ST6);
  const polls = [];
  for (let i = 0; i < 8; i++) polls.push((await status(s6))[1]);
  const en6 = await post(s6, "/api/sync/v1/enable", {});
  const calls6 = fake.calls.get(ST6);
  await new Promise((r) => setTimeout(r, 600));
  polls.push((await status(s6))[1]);
  const calls6b = fake.calls.get(ST6);
  fake.down = false;
  ok(calls6 === 1 && calls6b === 2 && polls.every((x) => x.reason === "cocalc_unreachable" && x.retry_after === 5000) && en6.status === 503 && (await nothing(ST6)),
    "8 statuses and an enable during an outage: one CoCalc request, then one more after the retry gate, each unreachable with retry_after: " + JSON.stringify({ calls6, calls6b, en: en6.status }));
  await new Promise((r) => setTimeout(r, 600));
  // and a status from another site is refused like every sync request
  const xr = await fetchAt(SITE, "/api/sync/v1/status", { headers: { cookie: s1, origin: "https://evil.test" } });
  ok(xr.status === 403, "a status asked from another site is refused (403)");
}

// ---- astra's narrowed CORR-PR58-1, last: it waits for a whole purge, so it runs after the cases whose clocks a
// retention of "days" (seconds here) drives, and can't push them past their windows
{
  const sp = await signIn(P2);
  const mine = sha("sagebrush-account\n" + P2);
  // (astra's narrowed CORR-PR58-1: the generation retired and the next turned on while a PUT bound to the old one is
  // past its first check, held just before its allocation: refused there, nothing allocated or stored in the new one)
  const gateP2 = (on) => fetchAt(SITE, `/__test/gate?name=reserve-allocate&on=${on ? 1 : 0}`, { method: "POST" });
  const bytes4 = Buffer.from("bytes of generation 1, late");
  await gateP2(true);
  const latePut = fetchAt(SITE, `/api/sync/v1/blob/${sha(bytes4)}`, { method: "PUT", headers: { cookie: sp, origin: SITE, "content-type": "application/octet-stream", "x-sync-account": mine, "x-sync-generation": "1" }, body: bytes4 });
  await new Promise((r) => setTimeout(r, 300));
  const acctP2 = acctNs.get(acctNs.idFromName("acct:" + mine));
  ok((await del(sp, P2)).status === 202, "(P2: Delete my synced data, generation 1, while the PUT waits)");
  ok(await until(async () => (await db.prepare("SELECT state FROM sync_accounts WHERE account_hash = ?1").bind(mine).first())?.state === "purged" && (await acctP2.lifecycle())?.record_pending === false), "(the purge finishes)");
  const en2P2 = await (await post(sp, "/api/sync/v1/enable", {})).json();
  ok(en2P2.generation === 2, "(P2 turned on again: generation 2)");
  await gateP2(false);
  const lr = await latePut;
  const lrb = await lr.json().catch(() => ({}));
  ok(lr.status === 409 && lrb.reason === "generation", "a PUT bound to generation 1, held across its purge and generation 2's start, is refused at its allocation: " + JSON.stringify({ status: lr.status, body: lrb }));
  const chk2 = await (await fetchAt(SITE, "/api/sync/v1/blobs/check", { method: "POST", headers: { cookie: sp, origin: SITE, "content-type": "application/json", "x-sync-account": mine, "x-sync-generation": "2" }, body: JSON.stringify({ blobs: [{ sha256: sha(bytes4), size: bytes4.length }] }) })).json();
  ok(chk2.missing?.includes(sha(bytes4)), "…and generation 2 holds nothing of it");
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
