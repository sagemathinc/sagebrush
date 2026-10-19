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
const D = "44444444-4444-4444-8444-444444444444"; // allowlisted; its limits are first asked for while CoCalc is down
const E = "55555555-5555-4555-8555-555555555555"; // allowlisted; nothing pending but what a test makes (alarms)

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
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret" };
const URL_KEY = "url-key";
const LOSE = "fa17fa17fa17";
// ---- a fake CoCalc: the limits (§6)
const fake = { limits: new Map(), down: false };
const sync = (storage, reads) => ({ storage_bytes: 1 << 30, max_file_bytes: 50_000, sync: { enabled: true, storage_bytes: storage, version_bytes: 1000, read_bytes_per_day: reads } });
fake.limits.set(A, sync(30_000, 60_000));
fake.limits.set(B, sync(1 << 20, 1 << 20));
fake.limits.set(D, sync(1 << 20, 1 << 20));
fake.limits.set(E, sync(1 << 20, 1 << 20));
async function cocalc(req) {
  const u = new URL(req.url);
  if (u.pathname === "/api/v2/sagebrush/limits") {
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
      bindings: { ...shareBindings, SYNC_ACCOUNTS: `${A}, ${B},${D},${E}`, SYNC_URL_KEY: URL_KEY, FILES_ORIGIN: "https://files.test", SYNC_SITE_ORIGIN: SITE, SYNC_TEST_PIN_MS: "300", SYNC_TEST_LOSE: LOSE },
      durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
      routes: ["sagebrush.test/*", "files.test/*"],
      outboundService: cocalc,
      ratelimits: { SYNC_PREAUTH: { namespace_id: "1001", simple: { limit: 100000, period: 60 } }, SYNC_FILES_LIMIT: { namespace_id: "1003", simple: { limit: 100000, period: 60 } } },
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
      ratelimits: { SYNC_PREAUTH: { namespace_id: "1002", simple: { limit: 3, period: 60 } } },
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
async function socket(session, origin = SITE) {
  const r = await fetchAt(SITE, "/api/sync/v1/account", { headers: { cookie: session, origin, upgrade: "websocket" } });
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
  s.send({ t: "hello", v: 1, device, name: "test", index_after });
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
  const sn = await signIn(A, "https://nolimit.test");
  r = await fetchAt("https://nolimit.test", "/api/sync/v1/enable", { method: "POST", headers: { cookie: sn, origin: "https://nolimit.test", "content-type": "application/json" }, body: "{}" });
  ok(r.status === 404, "with the objects bound but no pre-authentication limit, sync is off too");
  // the limit comes before any session is read: requests with no session get 429, not 401, once it is used up
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetchAt("https://tight.test", "/api/sync/v1/enable", { method: "POST", headers: { origin: "https://tight.test", "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: "{}" })).status);
  ok(codes.join() === "401,401,401,429,429", "the pre-authentication limit is per IP and before the session check: " + codes.join());
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
  ok(e.status === 200 && (await e.json()).state === "active", "turning sync on");
  ok((await post(sa, "/api/sync/v1/enable", {})).status === 200, "again is a no-op");
  ok((await socket(sa, "https://evil.test")).status === 403, "a socket upgrade from another origin is refused (cross-site WebSocket hijacking)");
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
  ok(welcome?.t === "welcome" && welcome.v === 1 && welcome.next_dseq === 1 && welcome.state === "active", "welcome");
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
const acctNs = await mf.getDurableObjectNamespace("SYNC_ACCOUNT", "sync");
const hashOf = (id) => createHash("sha256").update("sagebrush-account\n" + id).digest("hex");
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
  ok(r.status === 507 && (await r.json()).error === "storage_full", "over sync.storage_bytes: storage_full");
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
  const sd = await signIn(D);
  await post(sd, "/api/sync/v1/enable", {});
  r = await put(sd, Buffer.from("d while down"));
  ok(r.status === 503 && (await r.json()).error === "busy", "CoCalc down and nothing cached: the upload waits, never read as zero or as no limit");
  fake.down = false;
  r = await put(sd, Buffer.from("d while down"));
  ok(r.status === 201, "and goes once CoCalc answers");
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
  await new Promise((r) => setTimeout(r, 1500));
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
  await new Promise((res) => setTimeout(res, 2500));
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
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await mf.dispatchFetch(`https://tightfiles.test${loc.pathname}${loc.search}`, { headers: { "cf-connecting-ip": "198.51.100.7" } })).status);
  ok(codes[2] === 429, "a reused signed URL is limited per IP at the files Worker, before R2: " + codes.join());
  ok((await mf.dispatchFetch(`https://openfiles.test${loc.pathname}${loc.search}`)).status === 404, "without the per-IP limit bound, the files Worker serves no signed read");
  // a malformed plan from CoCalc is an outage: the last good limits stay
  fake.limits.set(B, { storage_bytes: 1 << 30, max_file_bytes: 50_000 });
  await new Promise((res) => setTimeout(res, 1200));
  let up = await put(sb, Buffer.from("b after a malformed plan"));
  ok(up.status === 201, "a plan without its sync part keeps the last good limits, never sync off");
  fake.limits.set(B, { storage_bytes: 1 << 30, max_file_bytes: 50_000, sync: { enabled: true, storage_bytes: "lots", version_bytes: 1, read_bytes_per_day: 1 } });
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
  await new Promise((res) => setTimeout(res, 4500));
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
    const quiet = await acctE().inspect({});
    ok(quiet?.alarm === null || quiet.alarm > Date.now() + 3600_000, "(account E has no alarm soon before the pin: only the unused holding's, a day away)");
    const t0 = Date.now();
    se1.send({ ...batch(docM, 1, [[1, pid(60, M), [], "crash", [sha(HE)]]]), req: 9999 });
    await new Promise((r) => setTimeout(r, 60));
    const ia = await acctE().inspect({ sha256: sha(HE) });
    ok(ia?.alarm !== null && ia.alarm >= t0 + 300 && ia.alarm <= t0 + 300 + 200, "the pending pin arms the alarm for its lapse, before the forward answers");
    await acctE().crash().catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    // (the restarted object, with the document still holding the answer)
    const ib = await acctE().inspect({ sha256: sha(HE) }).catch(() => null);
    ok(ib?.alarm !== null && ib?.alarm !== undefined && ib.alarm < Date.now() + 3600_000 && ib.pins.length === 1 && ib.pins[0].state === "pending", "after a crash that lost the alarm, the restarted object arms it again for the pending pin");
    await dm.open({ name: `after:${pid(60, M)}` });
    await new Promise((r) => setTimeout(r, 1500));
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
  await new Promise((r) => setTimeout(r, 1500));
  const ie = await acctA.inspect({ sha256: sha(H) });
  ok(ie?.pins.filter((p) => String(p.ref).endsWith(pid(70, N)))[0]?.state === "held", "an alarm that fires before a pin's lapse leaves the next armed: the pin is decided");
  s3.ws.close();
  s1.ws.close();
  s2.ws.close();
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

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
